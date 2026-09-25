/**
 * motivation-pg.js — схема мотивации аутсорса (2026-09-25).
 *
 * Только init(): таблицы создаёт Node (как и остальные *-pg.js), а весь
 * API — на dotnet (MotivationService.cs), он читает/пишет по готовой схеме.
 *
 * motivation_people — кто из акта подрядчика под какой учёткой WMS работал
 * в смену. received_at — когда учётка получена от подрядчика (сравнивается
 * со сроком: день — 10:00, ночь — 22:00, см. настройки).
 * motivation_settings — нормы (JSON под ключом 'norms').
 */

const pg = require('pg');
const { Pool } = pg;

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});
pool.on('error', err => console.error('[pg] motivation pool:', err.message));

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS motivation_people (
      id            BIGSERIAL PRIMARY KEY,
      shift_date    DATE NOT NULL,
      shift         TEXT NOT NULL,
      company       TEXT NOT NULL DEFAULT '',
      fio           TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'picker',
      executor_id   TEXT NOT NULL DEFAULT '',
      executor_name TEXT NOT NULL DEFAULT '',
      received_at   TIMESTAMPTZ NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS motivation_people_shift_idx ON motivation_people (shift_date, shift)');
  // Одна учётка — один человек за смену: иначе выработка двоих, работавших
  // под одной учёткой, досталась бы обоим.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS motivation_people_account_idx
    ON motivation_people (shift_date, shift, executor_id)
    WHERE executor_id <> ''
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS motivation_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `);
}

module.exports = { init };
