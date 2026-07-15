/**
 * migrate-empl-json-to-pg.js — переносит реальный реестр сотрудников
 * (executorId/fio/company/phone/password) из migration-staging/empl.json
 * (выгружен вручную с основного проекта на хосте — тот тоже на Postgres,
 * empl-pg.js, та же схема, тот же формат {employees:[...]}, что и
 * GET /api/employees) в таблицу employees этого проекта. По образцу
 * остальных migrate-*-to-pg.js: ON CONFLICT (executor_id) DO UPDATE —
 * безопасный, аддитивный upsert, НЕ TRUNCATE (не затирает то, что уже
 * накоплено вручную в этой базе).
 *
 * Запуск:
 *   docker compose exec node node backend/migrate-empl-json-to-pg.js
 *
 * Переменные окружения: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD
 */

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const EMPL_JSON_PATH = path.join(__dirname, '..', 'migration-staging', 'empl.json');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});

async function main() {
  if (!fs.existsSync(EMPL_JSON_PATH)) {
    console.log('migration-staging/empl.json не найден — нечего переносить:', EMPL_JSON_PATH);
    await pool.end();
    return;
  }

  const data = JSON.parse(fs.readFileSync(EMPL_JSON_PATH, 'utf8'));
  const employees = Array.isArray(data.employees) ? data.employees : [];
  console.log(`Найдено сотрудников в empl.json: ${employees.length}`);

  const { rows: beforeRows } = await pool.query('SELECT COUNT(*) FROM employees');
  console.log(`В таблице employees до переноса: ${beforeRows[0].count} записей`);

  let inserted = 0, skipped = 0, errors = 0;
  for (const e of employees) {
    const executorId = (e.executorId || '').trim();
    const fio = (e.fio || '').trim();
    if (!executorId || !fio) { skipped++; continue; }
    try {
      await pool.query(`
        INSERT INTO employees (executor_id, fio, company, phone, password)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (executor_id) DO UPDATE SET
          fio = $2, company = $3, phone = $4, password = $5
      `, [executorId, fio, e.company || '', e.phone || '', e.password || '']);
      inserted++;
    } catch (err) {
      console.error(`Ошибка для ${executorId} (${fio}):`, err.message);
      errors++;
    }
  }

  const { rows: afterRows } = await pool.query('SELECT COUNT(*) FROM employees');
  console.log(`\nПеренесено/обновлено: ${inserted}, пропущено (нет executorId/fio): ${skipped}, ошибок: ${errors}`);
  console.log(`В таблице employees после переноса: ${afterRows[0].count} записей`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
