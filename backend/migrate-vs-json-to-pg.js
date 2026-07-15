/**
 * migrate-vs-json-to-pg.js — переносит vs-users.json/vs-sessions.json в PostgreSQL
 * (по образцу migrate-json-to-pg.js). Одноразовый скрипт для перехода на
 * vs-auth-pg.js — без него включение USE_PG=true означало бы, что все
 * существующие пользователи и активные сессии «пропадут» (новые таблицы
 * пустые, пока их не наполнить).
 *
 * Запуск:
 *   docker exec <container> node /app/backend/migrate-vs-json-to-pg.js
 *
 * Переменные окружения: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD
 */

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Переопределяемо через env — для разового переноса реальных данных с
// другого хоста (migration-staging/), где файлы лежат не по стандартным
// путям persist-тома этого контейнера (см. DATA_MIGRATION_HOWTO.md).
const VS_USERS_PATH = process.env.VS_USERS_PATH_OVERRIDE || path.join(__dirname, 'vs-users.json');
const VS_SESSIONS_PATH = process.env.VS_SESSIONS_PATH_OVERRIDE || path.join(__dirname, 'data', 'vs-sessions.json');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vs_users (
      login               TEXT PRIMARY KEY,
      name                TEXT,
      role                TEXT,
      modules             JSONB,
      actions             JSONB,
      shift_type          TEXT,
      company_ids         JSONB,
      visible_companies   JSONB,
      allow_without_token BOOLEAN NOT NULL DEFAULT false,
      self_only           BOOLEAN NOT NULL DEFAULT false,
      password_hash       TEXT,
      wms_phone           TEXT,
      telegram_chat_id    TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vs_sessions (
      session_id          TEXT PRIMARY KEY,
      login               TEXT,
      role                TEXT,
      name                TEXT,
      shift_type          TEXT,
      company_ids         JSONB,
      modules             JSONB,
      allow_without_token BOOLEAN NOT NULL DEFAULT false,
      self_only           BOOLEAN NOT NULL DEFAULT false,
      created_at          BIGINT,
      last_active_at      BIGINT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS vs_sessions_last_active_idx ON vs_sessions (last_active_at)`);
}

async function migrateUsers() {
  if (!fs.existsSync(VS_USERS_PATH)) {
    console.log('vs-users.json не найден — пропускаем (нечего переносить):', VS_USERS_PATH);
    return { inserted: 0, errors: 0 };
  }
  const data = JSON.parse(fs.readFileSync(VS_USERS_PATH, 'utf8'));
  const users = Array.isArray(data.users) ? data.users : [];
  console.log(`Найдено пользователей: ${users.length}`);

  let inserted = 0, errors = 0;
  for (const u of users) {
    if (!u.login) { errors++; continue; }
    try {
      await pool.query(`
        INSERT INTO vs_users (login, name, role, modules, actions, shift_type, company_ids, visible_companies, allow_without_token, self_only, password_hash, wms_phone, telegram_chat_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (login) DO UPDATE SET
          name = $2, role = $3, modules = $4, actions = $5, shift_type = $6, company_ids = $7,
          visible_companies = $8, allow_without_token = $9, self_only = $10, password_hash = $11,
          wms_phone = $12, telegram_chat_id = $13
      `, [
        u.login, u.name || null, u.role || null,
        u.modules !== undefined ? JSON.stringify(u.modules) : null,
        u.actions !== undefined ? JSON.stringify(u.actions) : null,
        u.shiftType || null,
        u.companyIds !== undefined ? JSON.stringify(u.companyIds) : null,
        u.visibleCompanies !== undefined ? JSON.stringify(u.visibleCompanies) : null,
        !!u.allowWithoutToken, !!u.selfOnly, u.passwordHash || null, u.wmsPhone || null, u.telegramChatId || null,
      ]);
      inserted++;
    } catch (e) {
      console.error(`Ошибка для пользователя ${u.login}:`, e.message);
      errors++;
    }
  }
  return { inserted, errors };
}

async function migrateSessions() {
  if (!fs.existsSync(VS_SESSIONS_PATH)) {
    console.log('vs-sessions.json не найден — пропускаем:', VS_SESSIONS_PATH);
    return { inserted: 0, errors: 0, skippedExpired: 0 };
  }
  const data = JSON.parse(fs.readFileSync(VS_SESSIONS_PATH, 'utf8'));
  const entries = Object.entries(data || {});
  console.log(`Найдено сессий: ${entries.length}`);

  const now = Date.now();
  let inserted = 0, errors = 0, skippedExpired = 0;
  for (const [sid, s] of entries) {
    const lastActive = s.lastActiveAt || s.createdAt || 0;
    if (now - lastActive > SESSION_TTL_MS) { skippedExpired++; continue; }
    try {
      await pool.query(`
        INSERT INTO vs_sessions (session_id, login, role, name, shift_type, company_ids, modules, allow_without_token, self_only, created_at, last_active_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (session_id) DO UPDATE SET
          login = $2, role = $3, name = $4, shift_type = $5, company_ids = $6, modules = $7,
          allow_without_token = $8, self_only = $9, created_at = $10, last_active_at = $11
      `, [
        sid, s.login || null, s.role || null, s.name || null, s.shiftType || null,
        s.companyIds !== undefined ? JSON.stringify(s.companyIds) : null,
        s.modules !== undefined ? JSON.stringify(s.modules) : null,
        !!s.allowWithoutToken, !!s.selfOnly, s.createdAt || null, s.lastActiveAt || null,
      ]);
      inserted++;
    } catch (e) {
      console.error(`Ошибка для сессии ${sid}:`, e.message);
      errors++;
    }
  }
  return { inserted, errors, skippedExpired };
}

async function main() {
  console.log('Создаём таблицы (если ещё нет)...');
  await ensureTables();

  console.log('Мигрируем пользователей...');
  const usersResult = await migrateUsers();
  console.log(`Пользователи: перенесено ${usersResult.inserted}, ошибок ${usersResult.errors}`);

  console.log('Мигрируем сессии...');
  const sessionsResult = await migrateSessions();
  console.log(`Сессии: перенесено ${sessionsResult.inserted}, пропущено (истекли) ${sessionsResult.skippedExpired}, ошибок ${sessionsResult.errors}`);

  const { rows: userRows } = await pool.query('SELECT COUNT(*) FROM vs_users');
  const { rows: sessRows } = await pool.query('SELECT COUNT(*) FROM vs_sessions');
  console.log(`\nГотово. В таблице vs_users: ${userRows[0].count} записей, в vs_sessions: ${sessRows[0].count} записей.`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
