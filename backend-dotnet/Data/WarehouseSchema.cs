using Npgsql;
using BackendDotnet.Services;

namespace BackendDotnet.Data;

// Разделение данных по складам — правка схемы при старте dotnet (один раз,
// дальше каждый шаг видит, что уже сделано, и ничего не трогает).
//
// Во все таблицы с данными склада добавляется warehouse_id. Строки, что уже
// есть, получают СПБ-3 (DEFAULT при ADD COLUMN в Postgres 11+ — только
// метаданные, таблица не переписывается, даже большая wms_ops). DEFAULT
// остаётся и дальше: кто пишет, не указав склад (старый код, ручные скрипты),
// пишет в СПБ-3 — как было до разделения.
//
// Ключи и уникальные индексы, по которым идёт слияние/обновление строк,
// дополняются warehouse_id — иначе одинаковые ключи разных складов
// (ячейки называются одинаково, настройки по одному ключу) сталкивались бы.
public static class WarehouseSchema
{
    // таблица → её ключ/уникальность (с warehouse_id первым столбцом)
    private static readonly string[] Tables =
    {
        "wms_ops", "wms_placement", "wms_receiving", "wms_remains", "wms_stock_moves", "wms_storage_agg",
        "employees", "employee_account_checks", "routes",
        "tsd_assignments", "tsd_manual_employees", "tsd_settings",
        "motivation_people", "motivation_settings",
    };

    public static async Task EnsureAsync(string connectionString)
    {
        await using var conn = new NpgsqlConnection(connectionString);
        await conn.OpenAsync();
        var def = WarehouseService.DefaultWarehouseId;

        async Task Exec(string sql)
        {
            await using var cmd = new NpgsqlCommand(sql, conn) { CommandTimeout = 0 };
            await cmd.ExecuteNonQueryAsync();
        }
        async Task<bool> TableExists(string t)
        {
            await using var cmd = new NpgsqlCommand("SELECT to_regclass($1) IS NOT NULL", conn);
            cmd.Parameters.AddWithValue(t);
            return (bool)(await cmd.ExecuteScalarAsync())!;
        }
        // столбцы первичного ключа таблицы
        async Task<List<string>> PrimaryKey(string t)
        {
            await using var cmd = new NpgsqlCommand(@"
                SELECT a.attname FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE i.indrelid = $1::regclass AND i.indisprimary", conn);
            cmd.Parameters.AddWithValue(t);
            var cols = new List<string>();
            await using var r = await cmd.ExecuteReaderAsync();
            while (await r.ReadAsync()) cols.Add(r.GetString(0));
            return cols;
        }
        async Task EnsurePrimaryKey(string t, string cols)
        {
            if (!await TableExists(t)) return;
            var pk = await PrimaryKey(t);
            if (pk.Contains("warehouse_id")) return;
            Console.WriteLine($"[warehouses] {t}: первичный ключ → ({cols})");
            await Exec($"ALTER TABLE {t} DROP CONSTRAINT IF EXISTS {t}_pkey; ALTER TABLE {t} ADD PRIMARY KEY ({cols});");
        }

        // 0) журнал перемещений ЕО (спуск/пополнение/размещение из
        // stocks/changes) — новая таблица без бэкфилла из JSON, поэтому
        // создаётся здесь (сразу со складом; уникальность слияния — в шаге 2)
        await Exec($@"
            CREATE TABLE IF NOT EXISTS wms_stock_moves (
              id BIGSERIAL PRIMARY KEY,
              warehouse_id TEXT NOT NULL DEFAULT '{def}',
              date DATE NOT NULL,
              hour SMALLINT NOT NULL,
              merge_key TEXT NOT NULL,
              operation_type TEXT NOT NULL DEFAULT '',
              source_cell_address TEXT NOT NULL DEFAULT '',
              source_handling_unit_barcode TEXT NOT NULL DEFAULT '',
              target_cell_address TEXT NOT NULL DEFAULT '',
              target_handling_unit_barcode TEXT NOT NULL DEFAULT '',
              nomenclature_code TEXT NOT NULL DEFAULT '',
              product_name TEXT NOT NULL DEFAULT '',
              product_id TEXT NOT NULL DEFAULT '',
              quantity NUMERIC NOT NULL DEFAULT 0,
              responsible_user JSONB,
              executor_id TEXT NOT NULL DEFAULT '',
              executor TEXT NOT NULL DEFAULT '',
              started_at TIMESTAMPTZ,
              completed_at TIMESTAMPTZ
            )");

        // таблица могла быть создана до появления product_id (2026-10-24)
        await Exec("ALTER TABLE wms_stock_moves ADD COLUMN IF NOT EXISTS product_id TEXT NOT NULL DEFAULT ''");

        // 0б) приёмка: SKU и штуки поставки (2026-10-23) — раньше не хранились
        if (await TableExists("wms_receiving"))
            await Exec("ALTER TABLE wms_receiving ADD COLUMN IF NOT EXISTS sku_count NUMERIC NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS pieces NUMERIC NOT NULL DEFAULT 0");

        // 1) столбец склада
        foreach (var t in Tables)
        {
            if (!await TableExists(t)) continue;
            await Exec($"ALTER TABLE {t} ADD COLUMN IF NOT EXISTS warehouse_id TEXT NOT NULL DEFAULT '{def}'");
        }

        // 2) уникальность слияния операций: (date, hour, merge_key) → со складом
        foreach (var t in new[] { "wms_ops", "wms_placement", "wms_receiving", "wms_remains", "wms_stock_moves" })
        {
            if (!await TableExists(t)) continue;
            await Exec($@"
                DO $$
                DECLARE c text;
                BEGIN
                  IF to_regclass('{t}_wh_merge_idx') IS NULL THEN
                    RAISE NOTICE '{t}: уникальный индекс со складом';
                    CREATE UNIQUE INDEX {t}_wh_merge_idx ON {t} (warehouse_id, date, hour, merge_key);
                  END IF;
                  FOR c IN
                    SELECT con.conname FROM pg_constraint con
                    WHERE con.conrelid = '{t}'::regclass AND con.contype = 'u'
                      AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                           WHERE a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)) = ARRAY['date','hour','merge_key']
                  LOOP
                    EXECUTE format('ALTER TABLE {t} DROP CONSTRAINT %I', c);
                  END LOOP;
                END $$;");
        }

        // 3) первичные ключи «по ключу» → со складом
        await EnsurePrimaryKey("wms_storage_agg", "warehouse_id, date, shift");
        await EnsurePrimaryKey("employees", "warehouse_id, executor_id");
        await EnsurePrimaryKey("employee_account_checks", "warehouse_id, executor_id");
        await EnsurePrimaryKey("tsd_settings", "warehouse_id, key");
        await EnsurePrimaryKey("motivation_settings", "warehouse_id, key");

        // 4) частичные уникальные индексы
        if (await TableExists("tsd_assignments"))
            await Exec(@"
                DO $$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'tsd_assignments_active_tsd_idx' AND indexdef LIKE '%warehouse_id%') THEN
                    DROP INDEX IF EXISTS tsd_assignments_active_tsd_idx;
                    CREATE UNIQUE INDEX tsd_assignments_active_tsd_idx ON tsd_assignments (warehouse_id, tsd) WHERE returned_at IS NULL;
                  END IF;
                END $$;");
        if (await TableExists("motivation_people"))
            await Exec(@"
                DO $$ BEGIN
                  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'motivation_people_account_idx' AND indexdef LIKE '%warehouse_id%') THEN
                    DROP INDEX IF EXISTS motivation_people_account_idx;
                    CREATE UNIQUE INDEX motivation_people_account_idx ON motivation_people (warehouse_id, shift_date, shift, executor_id) WHERE executor_id <> '';
                  END IF;
                END $$;");

        // 5) выборки по дате — со складом впереди
        foreach (var t in new[] { "routes", "motivation_people" })
            if (await TableExists(t))
                await Exec($"CREATE INDEX IF NOT EXISTS {t}_wh_idx ON {t} (warehouse_id)");

        Console.WriteLine("[warehouses] схема готова");
    }
}
