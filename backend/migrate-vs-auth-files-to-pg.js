/**
 * migrate-vs-auth-files-to-pg.js — переносит 4 файловых поддомена
 * vs-auth-pg.js (Фаза 4) в PostgreSQL: vs-custom-roles.json,
 * vs-pending-users.json, vs-logins.json, vs-telegram-bind.json.
 * Сессии/пользователи уже в Postgres с Фазы 0 — не трогаем.
 *
 * Запуск:
 *   docker exec <node-container> node /app/backend/migrate-vs-auth-files-to-pg.js
 *
 * Переменные окружения: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Переопределяемо через env — для разового переноса реальных данных с
// другого хоста (migration-staging/), см. DATA_MIGRATION_HOWTO.md.
const DATA_DIR = path.join(__dirname, 'data');
const VS_PENDING_PATH = process.env.VS_PENDING_PATH_OVERRIDE || path.join(DATA_DIR, 'vs-pending-users.json');
const VS_CUSTOM_ROLES_PATH = process.env.VS_CUSTOM_ROLES_PATH_OVERRIDE || path.join(DATA_DIR, 'vs-custom-roles.json');
const VS_LOGINS_PATH = process.env.VS_LOGINS_PATH_OVERRIDE || path.join(DATA_DIR, 'vs-logins.json');
const VS_TELEGRAM_BIND_PATH = process.env.VS_TELEGRAM_BIND_PATH_OVERRIDE || path.join(DATA_DIR, 'vs-telegram-bind.json');

const pool = new Pool({
  host: process.env.PG_HOST || 'postgres',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB || 'zlp',
  user: process.env.PG_USER || 'zlp',
  password: process.env.PG_PASSWORD || '',
});

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vs_custom_roles (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      modules JSONB NOT NULL DEFAULT '[]'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vs_pending_users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT NOT NULL,
      wms_phone TEXT,
      site_password_hash TEXT,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending',
      normalized_phone TEXT NOT NULL UNIQUE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vs_logins (
      login_key TEXT PRIMARY KEY,
      last_attempt_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vs_telegram_bind_codes (
      code TEXT PRIMARY KEY,
      login TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
}

async function migrateCustomRoles() {
  if (!fs.existsSync(VS_CUSTOM_ROLES_PATH)) { console.log('vs-custom-roles.json не найден — пропускаем'); return; }
  const data = JSON.parse(fs.readFileSync(VS_CUSTOM_ROLES_PATH, 'utf8'));
  const roles = data.roles && typeof data.roles === 'object' ? data.roles : {};
  let n = 0;
  for (const [key, v] of Object.entries(roles)) {
    await pool.query(
      `INSERT INTO vs_custom_roles (key, label, modules) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET label = $2, modules = $3`,
      [key, v.label || key, JSON.stringify(Array.isArray(v.modules) ? v.modules : [])]
    );
    n++;
  }
  console.log(`vs_custom_roles: ${n} строк`);
}

async function migratePendingUsers() {
  if (!fs.existsSync(VS_PENDING_PATH)) { console.log('vs-pending-users.json не найден — пропускаем'); return; }
  const data = JSON.parse(fs.readFileSync(VS_PENDING_PATH, 'utf8'));
  const pending = Array.isArray(data.pending) ? data.pending : [];
  let n = 0;
  for (const p of pending) {
    const normalized = normalizePhone(p.phone);
    if (!normalized) continue;
    await pool.query(
      `INSERT INTO vs_pending_users (name, phone, wms_phone, site_password_hash, registered_at, status, normalized_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (normalized_phone) DO UPDATE SET
         name = $1, phone = $2, wms_phone = $3, site_password_hash = $4, registered_at = $5, status = $6`,
      [p.name || null, p.phone || null, p.wmsPhone || null, p.sitePasswordHash || null, p.registeredAt || new Date().toISOString(), p.status || 'pending', normalized]
    );
    n++;
  }
  console.log(`vs_pending_users: ${n} строк`);
}

async function migrateLogins() {
  if (!fs.existsSync(VS_LOGINS_PATH)) { console.log('vs-logins.json не найден — пропускаем'); return; }
  const data = JSON.parse(fs.readFileSync(VS_LOGINS_PATH, 'utf8'));
  const logins = data.logins && typeof data.logins === 'object' ? data.logins : {};
  let n = 0;
  for (const [key, rec] of Object.entries(logins)) {
    await pool.query(
      `INSERT INTO vs_logins (login_key, last_attempt_at, last_success_at) VALUES ($1, $2, $3)
       ON CONFLICT (login_key) DO UPDATE SET last_attempt_at = $2, last_success_at = $3`,
      [key, rec.lastAttemptAt || null, rec.lastSuccessAt || null]
    );
    n++;
  }
  console.log(`vs_logins: ${n} строк`);
}

async function migrateTelegramBindCodes() {
  if (!fs.existsSync(VS_TELEGRAM_BIND_PATH)) { console.log('vs-telegram-bind.json не найден — пропускаем'); return; }
  const data = JSON.parse(fs.readFileSync(VS_TELEGRAM_BIND_PATH, 'utf8'));
  const codes = data.codes && typeof data.codes === 'object' ? data.codes : {};
  let n = 0, skippedExpired = 0;
  for (const [code, entry] of Object.entries(codes)) {
    // Истёкшие коды не переносим — тот же принцип, что и с истёкшими
    // сессиями в Фазе 0.
    if (!entry.expiresAt || Date.now() > entry.expiresAt) { skippedExpired++; continue; }
    await pool.query(
      `INSERT INTO vs_telegram_bind_codes (code, login, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET login = $2, expires_at = $3`,
      [code, entry.login || '', new Date(entry.expiresAt).toISOString()]
    );
    n++;
  }
  console.log(`vs_telegram_bind_codes: ${n} строк (пропущено истёкших: ${skippedExpired})`);
}

async function main() {
  console.log('Создаём схему...');
  await createSchema();
  console.log('Переносим данные...');
  await migrateCustomRoles();
  await migratePendingUsers();
  await migrateLogins();
  await migrateTelegramBindCodes();
  console.log('Готово.');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
