/**
 * vs-auth-pg.js — то, что нужно node от учёток сайта (сами вход, регистрация,
 * роли и пользователи — в dotnet, Services/AuthService.cs):
 *  • проверка сессии запроса (getSession) и доступа к складу (applyWarehouse);
 *  • привязка Telegram менеджера (коды привязки, chat id).
 * init() создаёт таблицы учёток (vs_users, vs_sessions, vs_custom_roles,
 * vs_pending_users, vs_logins, vs_telegram_bind_codes) — их же читает dotnet.
 * Настройки: PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASSWORD.
 */

const pg   = require('pg');
const { Pool } = pg;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней (скользящий)
const SESSION_TOUCH_MIN_INTERVAL_MS = 60 * 1000; // не пишем last_active_at чаще раза в минуту
const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});
// Без обработчика обрыв простаивающего соединения (рестарт Postgres, сеть)
// всплывает как необработанное 'error' и роняет весь процесс Node.
pool.on('error', err => console.error('[pg] vs-auth pool:', err.message));

async function init() {
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

  // Фаза 4 — 4 поддомена, отложенных Фазой 0.
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
      name TEXT, phone TEXT NOT NULL, wms_phone TEXT, site_password_hash TEXT,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'pending',
      normalized_phone TEXT NOT NULL UNIQUE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vs_logins (
      login_key TEXT PRIMARY KEY,
      last_attempt_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vs_telegram_bind_codes (
      code TEXT PRIMARY KEY, login TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
    )
  `);
}

// ─── Row ↔ object ──────────────────────────────────────────────────────────────

function rowToSession(row) {
  return {
    login: row.login || '',
    role: row.role,
    name: row.name || undefined,
    shiftType: row.shift_type || undefined,
    companyIds: row.company_ids || undefined,
    modules: row.modules || undefined,
    allowWithoutToken: !!row.allow_without_token,
    selfOnly: !!row.self_only,
    createdAt: Number(row.created_at) || 0,
    lastActiveAt: Number(row.last_active_at) || 0,
  };
}

async function touchSession(sid, lastActiveAt) {
  await pool.query('UPDATE vs_sessions SET last_active_at = $2 WHERE session_id = $1', [sid, lastActiveAt]);
}

async function deleteSessionRow(sid) {
  await pool.query('DELETE FROM vs_sessions WHERE session_id = $1', [sid]);
}

// ─── Custom roles — Postgres (Фаза 4, была файлом до этого) ───────────────────

// ─── Сессии и пользователи — Postgres, без кэша ───────────────────────────────

// ─── Pending users (registration requests) — Postgres (Фаза 4) ────────────────

function isLetterLogin(login) {
  return /[a-zA-Zа-яА-ЯёЁ]/.test(String(login || '').trim());
}

async function getSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const res = await pool.query('SELECT * FROM vs_sessions WHERE session_id = $1', [sessionId]);
  if (!res.rows.length) return null;
  const session = rowToSession(res.rows[0]);
  const lastActive = session.lastActiveAt || session.createdAt || 0;
  if (Date.now() - lastActive > SESSION_TTL_MS) {
    await deleteSessionRow(sessionId);
    return null;
  }
  // Скользящий TTL — обновляем время последней активности, но не чаще раза
  // в минуту (иначе на каждый запрос по ~60 защищённым роутам была бы своя
  // запись в базу — TTL всё равно сдвигается плавно, минутной точности хватает).
  const now = Date.now();
  if (now - lastActive > SESSION_TOUCH_MIN_INTERVAL_MS) {
    await touchSession(sessionId, now);
    session.lastActiveAt = now;
  }
  return session;
}

// ─── Склад, выбранный на сайте (заголовок X-Warehouse) ──────────────────────
// Доступ к складам и роль на каждом — таблица vs_user_warehouses (ведёт
// backend-dotnet/Services/WarehouseService.cs). Ключ логина — как там:
// телефон +7XXXXXXXXXX, буквенный — в нижнем регистре.
function warehouseKey(login) {
  const t = String(login || '').trim()
  if (!t) return ''
  if (isLetterLogin(t)) return t.toLowerCase()
  const digits = t.replace(/\D/g, '')
  const ten = digits.length > 10 ? digits.slice(-10) : digits
  return ten.length === 10 ? '+7' + ten : t
}

/** Сессия с правами на выбранном складе: роль склада (если своя) и
 *  warehouseId. null — доступа к складу нет. Без заголовка — как есть. */
async function applyWarehouse(session, warehouseId) {
  const wid = String(warehouseId || '').trim()
  if (!session || !wid) return session
  if (session.role === 'developer') return { ...session, warehouseId: wid }
  let res
  try {
    res = await pool.query('SELECT role FROM vs_user_warehouses WHERE login = $1 AND warehouse_id = $2', [warehouseKey(session.login), wid])
  } catch (err) {
    if (err.code === '42P01') return session // таблицы ещё нет (dotnet её создаст)
    throw err
  }
  if (!res.rows.length) return null
  return { ...session, role: res.rows[0].role || session.role, warehouseId: wid }
}

// ─── Коды привязки Telegram — Postgres (Фаза 4) ────────────────────────────────

module.exports = {
  init,
  getSession,
  applyWarehouse,
};
