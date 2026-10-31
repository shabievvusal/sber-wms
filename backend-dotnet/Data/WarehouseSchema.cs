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
        "wms_ops", "wms_placement", "wms_receiving", "wms_remains", "wms_stock_moves", "wms_zgz_moves", "wms_storage_agg",
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

        // 00) базовые таблицы операций WMS — раньше их создавал только разовый
        // скрипт переноса migrate-storage-json-to-pg.js (удалён 2026-10-31).
        // Здесь — чтобы проект поднимался с нуля; в старом виде (без склада,
        // ключ date+hour+merge_key), дальше шаги ниже добавят warehouse_id и
        // недостающие колонки, как для существующих таблиц.
        await Exec(@"
            CREATE TABLE IF NOT EXISTS wms_ops (
              id BIGSERIAL PRIMARY KEY,
              date DATE NOT NULL, hour SMALLINT NOT NULL, merge_key TEXT NOT NULL,
              item_id TEXT, type TEXT, operation_type TEXT, product_name TEXT,
              product_id TEXT NOT NULL DEFAULT '',
              nomenclature_code TEXT, barcodes TEXT, production_date TEXT,
              best_before_date TEXT, source_barcode TEXT, cell TEXT, target_barcode TEXT,
              started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
              executor TEXT, executor_id TEXT,
              src_old NUMERIC, src_new NUMERIC, tgt_old NUMERIC, tgt_new NUMERIC, quantity NUMERIC,
              UNIQUE (date, hour, merge_key)
            )");
        await Exec("CREATE INDEX IF NOT EXISTS wms_ops_date_idx ON wms_ops (date)");
        await Exec("CREATE INDEX IF NOT EXISTS wms_ops_executor_id_idx ON wms_ops (executor_id)");
        await Exec(@"
            CREATE TABLE IF NOT EXISTS wms_placement (
              id BIGSERIAL PRIMARY KEY,
              date DATE NOT NULL, hour SMALLINT NOT NULL, merge_key TEXT NOT NULL,
              item_id TEXT, status TEXT, handling_unit_barcode TEXT,
              source_cell_address TEXT, target_cell_address TEXT,
              target_cells_addresses JSONB NOT NULL DEFAULT '[]',
              source_zone_id TEXT, source_zone_name TEXT,
              responsible_user JSONB NOT NULL DEFAULT '{}',
              executor_id TEXT, executor TEXT, created_at TIMESTAMPTZ,
              issue TEXT, condition TEXT, temperature_mode TEXT, sku_count NUMERIC,
              UNIQUE (date, hour, merge_key)
            )");
        await Exec(@"
            CREATE TABLE IF NOT EXISTS wms_receiving (
              id BIGSERIAL PRIMARY KEY,
              date DATE NOT NULL, hour SMALLINT NOT NULL, merge_key TEXT NOT NULL,
              item_id TEXT, status TEXT, type TEXT, task_number TEXT, order_number TEXT,
              supplier_name TEXT, started_at TIMESTAMPTZ,
              responsible_user JSONB NOT NULL DEFAULT '{}',
              executor_id TEXT, executor TEXT, completed_at TIMESTAMPTZ,
              volume_in_milliliters NUMERIC, weight_in_grams NUMERIC, eo_count NUMERIC,
              UNIQUE (date, hour, merge_key)
            )");
        await Exec(@"
            CREATE TABLE IF NOT EXISTS wms_remains (
              id BIGSERIAL PRIMARY KEY,
              date DATE NOT NULL, hour SMALLINT NOT NULL, merge_key TEXT NOT NULL,
              item_id TEXT, status TEXT, task_type TEXT,
              source_cell_address TEXT, source_handling_unit_barcode TEXT,
              target_cell_address TEXT, target_handling_unit_barcode TEXT,
              consolidation_items JSONB NOT NULL DEFAULT '[]',
              responsible_user JSONB NOT NULL DEFAULT '{}',
              executor_id TEXT, executor TEXT, created_at TIMESTAMPTZ,
              UNIQUE (date, hour, merge_key)
            )");
        await Exec(@"
            CREATE TABLE IF NOT EXISTS wms_storage_agg (
              date DATE NOT NULL, shift TEXT NOT NULL,
              total_storage_count NUMERIC NOT NULL DEFAULT 0,
              storage_by_hour JSONB NOT NULL DEFAULT '{}',
              total_weight_grams NUMERIC NOT NULL DEFAULT 0,
              weight_by_employee JSONB NOT NULL DEFAULT '{}',
              PRIMARY KEY (date, shift)
            )");

        // 01) небольшие данные склада «ключ → JSON» (перекличка, настройки,
        // «Обновлено», нарушения) — общая с Node таблица (backend/state-pg.js)
        await Exec(@"
            CREATE TABLE IF NOT EXISTS app_state (
              warehouse_id TEXT NOT NULL,
              key TEXT NOT NULL,
              value JSONB NOT NULL,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              PRIMARY KEY (warehouse_id, key)
            )");

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

        // 0в) переводы ЕО в ЗГЗ — «Поиск потеряшек» (2026-10-25)
        await Exec($@"
            CREATE TABLE IF NOT EXISTS wms_zgz_moves (
              id BIGSERIAL PRIMARY KEY,
              warehouse_id TEXT NOT NULL DEFAULT '{def}',
              date DATE NOT NULL,
              hour SMALLINT NOT NULL,
              merge_key TEXT NOT NULL,
              hu TEXT NOT NULL DEFAULT '',
              source_cell TEXT NOT NULL DEFAULT '',
              target_cell TEXT NOT NULL DEFAULT '',
              product_id TEXT NOT NULL DEFAULT '',
              product_name TEXT NOT NULL DEFAULT '',
              nomenclature_code TEXT NOT NULL DEFAULT '',
              barcodes TEXT NOT NULL DEFAULT '',
              quantity NUMERIC NOT NULL DEFAULT 0,
              executor_id TEXT NOT NULL DEFAULT '',
              executor TEXT NOT NULL DEFAULT '',
              completed_at TIMESTAMPTZ
            )");
        await Exec("CREATE INDEX IF NOT EXISTS wms_zgz_moves_completed_idx ON wms_zgz_moves (warehouse_id, completed_at)");

        // 0д) журнал найденных ЕО — «Поиск потеряшек» → «Нашли» (2026-10-29):
        // где ЕО числилась (ячейка КДК, ЦФЗ, ячейка ЗГЗ), где нашли, кто отбирал
        // и кто переводил — сводка «у кого ЕО теряются чаще».
        await Exec($@"
            CREATE TABLE IF NOT EXISTS zgz_found (
              id BIGSERIAL PRIMARY KEY,
              warehouse_id TEXT NOT NULL DEFAULT '{def}',
              hu TEXT NOT NULL,
              found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              found_by TEXT NOT NULL DEFAULT '',
              found_cell TEXT NOT NULL DEFAULT '',
              source_cell TEXT NOT NULL DEFAULT '',
              target_cell TEXT NOT NULL DEFAULT '',
              store TEXT NOT NULL DEFAULT '',
              moved_at TIMESTAMPTZ,
              mover TEXT NOT NULL DEFAULT '',
              pickers TEXT NOT NULL DEFAULT '',
              items INT NOT NULL DEFAULT 0,
              note TEXT NOT NULL DEFAULT ''
            )");
        await Exec("CREATE INDEX IF NOT EXISTS zgz_found_at_idx ON zgz_found (warehouse_id, found_at)");

        // 0г) ЦФЗ по ячейкам КДК (2026-10-25) — справочник из WMS topology
        await Exec($@"
            CREATE TABLE IF NOT EXISTS cell_stores (
              warehouse_id TEXT NOT NULL DEFAULT '{def}',
              address TEXT NOT NULL,
              store_name TEXT NOT NULL DEFAULT '',
              zone_id TEXT NOT NULL DEFAULT '',
              zone_name TEXT NOT NULL DEFAULT '',
              updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              PRIMARY KEY (warehouse_id, address)
            )");
        // id ячейки в WMS (2026-10-29) — для поиска в WMS по cellIds
        await Exec("ALTER TABLE cell_stores ADD COLUMN IF NOT EXISTS cell_id TEXT NOT NULL DEFAULT ''");

        // 0д) штрихкоды товаров из файла весов (2026-10-26) — заполняет Node
        // (product-weights.js), общая для складов, как product_weights
        await Exec("CREATE TABLE IF NOT EXISTS product_barcodes (barcode TEXT PRIMARY KEY, article TEXT NOT NULL)");
        // штук за один скан: 1 у штучного, вложенность у упаковки
        await Exec("ALTER TABLE product_barcodes ADD COLUMN IF NOT EXISTS qty NUMERIC NOT NULL DEFAULT 1");

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
        foreach (var t in new[] { "wms_ops", "wms_placement", "wms_receiving", "wms_remains", "wms_stock_moves", "wms_zgz_moves" })
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
