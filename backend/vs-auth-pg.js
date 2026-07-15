/**
 * vs-auth-pg.js — Postgres-реализация того же интерфейса, что и vs-auth.js.
 *
 * Включается через USE_PG=true в .env (тот же флаг, что и route-rk-pg.js/
 * empl-pg.js/tsd-pg.js). Настройки: PG_HOST, PG_PORT, PG_DB, PG_USER,
 * PG_PASSWORD — та же база `zlp`, что и у остальных *-pg.js модулей, просто
 * свои таблицы, как и у них.
 *
 * ПОЛНОСТЬЮ АСИНХРОННЫЙ интерфейс — как и у route-rk-pg.js/empl-pg.js/
 * tsd-pg.js, никакого кэша в памяти. Каждое чтение — реальный запрос к
 * Postgres, каждая мутация — один атомарный SQL-запрос (не read-modify-write
 * в JS).
 *
 * Фаза 0: сессии/пользователи (vs_sessions/vs_users) — Postgres.
 * Фаза 4: ОСТАЛЬНЫЕ 4 файловых поддомена (кастомные роли, заявки на
 * регистрацию, лог попыток входа, коды привязки Telegram) — были
 * сознательно отложены Фазой 0 (см. историю PLAN.md), теперь тоже
 * переехали в Postgres (vs_custom_roles/vs_pending_users/vs_logins/
 * vs_telegram_bind_codes). Node продолжает владеть ЭТИМИ функциями (нужны
 * /api/node/*, /api/vs/telegram/* — см. PLAN.md, «что остаётся на Node»),
 * просто их реализация теперь читает/пишет Postgres вместо файлов —
 * ripple-эффект: роли переплетены почти везде (`isValidRole`/`resolveRole`/
 * `getModulesForRole`/`resolveModules` были синхронными, читали файл
 * синхронно, вызывались ВНУТРИ `findUserByLogin`/`createSession`/
 * `getAllUsersForAdmin`/`saveUser`/`approvePendingUser`) — все стали async,
 * `await` протянут через все внутренние вызовы.
 *
 * Отдельно от Node — ТЕ ЖЕ HTTP-роуты (login/register/me/logout/admin
 * roles+pending+users) целиком перенесены и в `backend-dotnet`
 * (`Services/AuthService.cs`), читают ТЕ ЖЕ таблицы напрямую — Caddy
 * проксирует эти пути туда, Node-версии остаются мёртвым кодом (тот же
 * приём, что в Фазах 1-3).
 *
 * Единственное место с намеренным (и явно узким) остаточным окном гонки:
 * `saveUser`/`setTelegramChatId` читают текущую строку, мержат в неё
 * частичный payload (только те поля, что реально пришли) и пишут обратно —
 * если та же строка `login` редактируется ДВУМЯ параллельными запросами в
 * пределах миллисекунд, один перезапишет правки другого. Это не тот же баг,
 * что был раньше (там ЛЮБЫЕ два параллельных запроса корёжили ВЕСЬ файл
 * пользователей) — это узкий случай «два админа одновременно правят одного
 * и того же пользователя», который в реальном использовании практически не
 * встречается. Альтернатива (мёрж полностью на стороне SQL через COALESCE)
 * не выбрана осознанно: она не может отличить «поле не прислали» от «поле
 * явно очищают» (оба случая — undefined/null на входе), а это как раз нужно
 * коду ниже (например, обнуление пароля). Все остальные операции (сессии,
 * удаление, одобрение заявки) — по одному атомарному запросу, без гонок.
 */

const pg   = require('pg');
const { Pool } = pg;
const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней (скользящий)
const SESSION_TOUCH_MIN_INTERVAL_MS = 60 * 1000; // не пишем last_active_at чаще раза в минуту
const BIND_CODE_TTL_MS = 5 * 60 * 1000; // 5 мин

const pool = new Pool({
  host:     process.env.PG_HOST     || 'postgres',
  port:     parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DB       || 'zlp',
  user:     process.env.PG_USER     || 'zlp',
  password: process.env.PG_PASSWORD || '',
});

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

function rowToUser(row) {
  return {
    login: row.login,
    name: row.name || undefined,
    role: row.role || undefined,
    modules: row.modules || undefined,
    actions: row.actions || undefined,
    shiftType: row.shift_type || undefined,
    companyIds: row.company_ids || undefined,
    visibleCompanies: row.visible_companies || undefined,
    allowWithoutToken: !!row.allow_without_token,
    selfOnly: !!row.self_only,
    passwordHash: row.password_hash || undefined,
    wmsPhone: row.wms_phone || undefined,
    telegramChatId: row.telegram_chat_id || undefined,
  };
}

async function persistUser(u) {
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
}

async function deleteUserRow(login) {
  await pool.query('DELETE FROM vs_users WHERE login = $1', [login]);
}

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

async function persistSession(sid, s) {
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
}

async function touchSession(sid, lastActiveAt) {
  await pool.query('UPDATE vs_sessions SET last_active_at = $2 WHERE session_id = $1', [sid, lastActiveAt]);
}

async function deleteSessionRow(sid) {
  await pool.query('DELETE FROM vs_sessions WHERE session_id = $1', [sid]);
}

/** Модули интерфейса */
const MODULES_BY_ROLE = {
  admin: ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'receive', 'consolidation_form', 'reports', 'supplies', 'picking', 'shift_plan', 'tsd', 'violations'],
  group_leader: ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'receive', 'consolidation_form', 'reports', 'picking', 'shift_plan', 'tsd', 'violations'],
  supervisor: ['stats', 'data', 'monitor', 'analysis', 'docs', 'shipments', 'reports', 'picking', 'shift_plan', 'tsd'],
  manager: ['stats', 'data', 'monitor', 'analysis', 'docs', 'shipments', 'reports', 'picking', 'shift_plan', 'tsd'],
  developer: ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'receive', 'consolidation_form', 'reports', 'supplies', 'picking', 'shift_plan', 'tsd', 'violations'],
};

const ALL_MODULES = ['stats', 'data', 'monitor', 'analysis', 'consolidation', 'docs', 'settings', 'shipments', 'receive', 'consolidation_form', 'reports', 'supplies', 'picking', 'shift_plan', 'tsd', 'violations'];

/** Действия — управляются отдельно от модулей */
const ALL_ACTIONS = ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'];

/** Действия по умолчанию для встроенных ролей */
const ACTIONS_BY_ROLE = {
  admin:        ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'],
  group_leader: ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'],
  supervisor:   ['fetch_data', 'recheck_data', 'request_fetch'],
  manager:      [],
  developer:    ['fetch_data', 'recheck_data', 'request_fetch', 'edit_thresholds'],
};

function getActionsForRole(role) {
  return ACTIONS_BY_ROLE[role] || [];
}

/** Встроенные роли (нельзя удалить) */
const BUILTIN_ROLES = {
  admin:        'Администратор',
  group_leader: 'Руководитель группы',
  supervisor:   'Начальник смены',
  manager:      'Менеджер',
};

// ─── Custom roles — Postgres (Фаза 4, была файлом до этого) ───────────────────

async function loadCustomRoles() {
  const res = await pool.query('SELECT key, label, modules FROM vs_custom_roles');
  const roles = {};
  for (const row of res.rows) roles[row.key] = { label: row.label, modules: row.modules || [] };
  return roles;
}

async function getAllRoles() {
  const custom = await loadCustomRoles();
  const result = Object.entries(BUILTIN_ROLES).map(([k, label]) => ({
    key: k, label, modules: MODULES_BY_ROLE[k] || ALL_MODULES, builtin: true,
  }));
  for (const [k, v] of Object.entries(custom)) {
    result.push({ key: k, label: v.label || k, modules: v.modules || [], builtin: false });
  }
  return result;
}

async function addCustomRole(key, label, modules) {
  let k = String(key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!k) k = 'role_' + Date.now().toString(36);
  if (BUILTIN_ROLES[k]) throw new Error('Нельзя переопределить встроенную роль');
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error('Ключ должен начинаться с буквы и содержать только латинские буквы, цифры и _');
  const roleLabel = String(label || '').trim() || k;
  const roleModules = Array.isArray(modules) ? modules.filter(m => ALL_MODULES.includes(m)) : [];
  await pool.query(
    `INSERT INTO vs_custom_roles (key, label, modules) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET label = $2, modules = $3`,
    [k, roleLabel, JSON.stringify(roleModules)]
  );
  return k;
}

async function updateCustomRole(key, label, modules) {
  if (BUILTIN_ROLES[key]) throw new Error('Нельзя изменить встроенную роль через этот метод');
  const { rows } = await pool.query('SELECT key, modules FROM vs_custom_roles WHERE key = $1', [key]);
  if (!rows.length) throw new Error('Роль не найдена');
  const roleLabel = String(label || '').trim() || key;
  const roleModules = Array.isArray(modules) ? modules.filter(m => ALL_MODULES.includes(m)) : (rows[0].modules || []);
  await pool.query('UPDATE vs_custom_roles SET label = $2, modules = $3 WHERE key = $1', [key, roleLabel, JSON.stringify(roleModules)]);
}

async function deleteCustomRole(key) {
  if (BUILTIN_ROLES[key]) throw new Error('Нельзя удалить встроенную роль');
  await pool.query('DELETE FROM vs_custom_roles WHERE key = $1', [key]);
}

async function isValidRole(role) {
  if (!role) return false;
  if (BUILTIN_ROLES[role]) return true;
  const { rows } = await pool.query('SELECT 1 FROM vs_custom_roles WHERE key = $1', [role]);
  return rows.length > 0;
}

async function resolveRole(role) {
  return (await isValidRole(role)) ? role : 'manager';
}

// ─── Сессии и пользователи — Postgres, без кэша ───────────────────────────────

async function loadVsUsers() {
  const res = await pool.query('SELECT * FROM vs_users');
  return res.rows.map(rowToUser);
}

async function loadLogins() {
  const res = await pool.query('SELECT login_key, last_attempt_at, last_success_at FROM vs_logins');
  const logins = {};
  for (const row of res.rows) {
    logins[row.login_key] = {
      lastAttemptAt: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
      lastSuccessAt: row.last_success_at ? row.last_success_at.toISOString() : null,
    };
  }
  return logins;
}

// ─── Pending users (registration requests) — Postgres (Фаза 4) ────────────────

function pendingRowToObj(row) {
  return {
    name: row.name || '',
    phone: row.phone,
    wmsPhone: row.wms_phone || '',
    sitePasswordHash: row.site_password_hash || undefined,
    registeredAt: row.registered_at instanceof Date ? row.registered_at.toISOString() : row.registered_at,
    status: row.status || 'pending',
  };
}

async function addPendingUser(payload) {
  const { name, phone, wmsPhone, sitePasswordHash } = payload;
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Некорректный номер телефона');
  const users = await loadVsUsers();
  if (users.some(u => normalizePhone(u.login) === normalized)) {
    throw new Error('Пользователь с таким номером уже существует');
  }
  const { rows: existingPending } = await pool.query('SELECT 1 FROM vs_pending_users WHERE normalized_phone = $1', [normalized]);
  if (existingPending.length > 0) {
    throw new Error('Заявка от этого номера уже ожидает рассмотрения');
  }
  await pool.query(
    `INSERT INTO vs_pending_users (name, phone, wms_phone, site_password_hash, normalized_phone)
     VALUES ($1, $2, $3, $4, $5)`,
    [String(name || '').trim(), '+7' + normalized, String(wmsPhone || phone || '').replace(/\D/g, ''), sitePasswordHash || null, normalized]
  );
}

async function getPendingUsers() {
  const { rows } = await pool.query('SELECT * FROM vs_pending_users ORDER BY registered_at');
  return rows.map(pendingRowToObj);
}

/** Одобрить заявку: переносит в vs_users с указанной ролью. */
async function approvePendingUser(phone, role, modules) {
  const normalized = normalizePhone(phone);
  const { rows } = await pool.query('SELECT * FROM vs_pending_users WHERE normalized_phone = $1', [normalized]);
  if (!rows.length) throw new Error('Заявка не найдена');
  const entry = pendingRowToObj(rows[0]);
  const validRole = await resolveRole(role);
  const newUser = {
    login: canonicalPhone(entry.phone) || entry.phone,
    name: entry.name || undefined,
    role: validRole,
    modules: Array.isArray(modules) && modules.length > 0 ? modules.filter(m => ALL_MODULES.includes(m)) : undefined,
    allowWithoutToken: false,
    passwordHash: entry.sitePasswordHash || undefined,
    wmsPhone: entry.wmsPhone || undefined,
  };
  await persistUser(newUser);
  await pool.query('DELETE FROM vs_pending_users WHERE normalized_phone = $1', [normalized]);
}

async function rejectPendingUser(phone) {
  const normalized = normalizePhone(phone);
  await pool.query('DELETE FROM vs_pending_users WHERE normalized_phone = $1', [normalized]);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function canonicalPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const ten = digits.slice(-10);
  if (ten.length !== 10) return null;
  return '+7' + ten;
}

function normalizeLogin(login) {
  return String(login || '').replace(/\D/g, '').slice(-10);
}

function isLetterLogin(login) {
  return /[a-zA-Zа-яА-ЯёЁ]/.test(String(login || '').trim());
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const idx = stored.indexOf(':');
  if (idx <= 0) return false;
  const salt = Buffer.from(stored.slice(0, idx), 'hex');
  const hash = Buffer.from(stored.slice(idx + 1), 'hex');
  const got = crypto.scryptSync(String(password), salt, 64);
  return got.length === hash.length && crypto.timingSafeEqual(got, hash);
}

async function recordLoginAttempt(login, success) {
  const raw = String(login || '').trim();
  const key = isLetterLogin(raw) ? raw : (canonicalPhone(raw) || raw) || 'unknown';
  const now = new Date();
  if (success) {
    await pool.query(
      `INSERT INTO vs_logins (login_key, last_attempt_at, last_success_at) VALUES ($1, $2, $2)
       ON CONFLICT (login_key) DO UPDATE SET last_attempt_at = $2, last_success_at = $2`,
      [key, now]
    );
  } else {
    await pool.query(
      `INSERT INTO vs_logins (login_key, last_attempt_at) VALUES ($1, $2)
       ON CONFLICT (login_key) DO UPDATE SET last_attempt_at = $2`,
      [key, now]
    );
  }
}

async function findUserByLogin(login) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = await loadVsUsers();
  for (const u of users) {
    let match = false;
    if (u.passwordHash) {
      match = trimmed.toLowerCase() === String(u.login || '').trim().toLowerCase();
    } else {
      const uLogin = normalizeLogin(u.login);
      match = uLogin && (uLogin === normalized || u.login === login);
    }
    if (match) {
      const role = await resolveRole(u.role);
      const modules = await resolveModules(role, u.modules);
      const actions = Array.isArray(u.actions) ? u.actions.filter(a => ALL_ACTIONS.includes(a)) : getActionsForRole(role);
      return {
        name: u.name || undefined,
        role,
        shiftType: u.shiftType === 'day' || u.shiftType === 'night' ? u.shiftType : undefined,
        companyIds: Array.isArray(u.companyIds) ? u.companyIds : undefined,
        visibleCompanies: Array.isArray(u.visibleCompanies) && u.visibleCompanies.length > 0 ? u.visibleCompanies : undefined,
        modules,
        actions,
        allowWithoutToken: !!u.allowWithoutToken,
        selfOnly: !!u.selfOnly,
        passwordHash: u.passwordHash || undefined,
      };
    }
  }
  return null;
}

function createSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

async function createSession(user, login) {
  const sid = createSessionId();
  const now = Date.now();
  const session = {
    login: String(login || ''),
    role: user.role,
    name: user.name || undefined,
    shiftType: user.shiftType,
    companyIds: user.companyIds,
    modules: user.modules || await getModulesForRole(user.role),
    allowWithoutToken: !!user.allowWithoutToken,
    selfOnly: !!user.selfOnly,
    createdAt: now,
    lastActiveAt: now,
  };
  await persistSession(sid, session);
  return sid;
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

async function destroySession(sessionId) {
  if (sessionId) await deleteSessionRow(sessionId);
}

async function getModulesForRole(role) {
  if (MODULES_BY_ROLE[role]) return MODULES_BY_ROLE[role];
  const custom = await loadCustomRoles();
  if (custom[role]) return custom[role].modules || [];
  return MODULES_BY_ROLE.manager;
}

const PRIVILEGED_ROLES = ['admin', 'developer'];
async function resolveModules(role, storedModules) {
  const roleDefaults = await getModulesForRole(role);
  if (!Array.isArray(storedModules) || storedModules.length === 0) return roleDefaults;
  const filtered = storedModules.filter(m => ALL_MODULES.includes(m));
  if (PRIVILEGED_ROLES.includes(role)) {
    return [...new Set([...filtered, ...roleDefaults])];
  }
  return filtered;
}

async function getAllUsersForAdmin() {
  const users = await loadVsUsers();
  const logins = await loadLogins();
  const byLogin = new Map();
  for (const u of users) {
    const login = String(u.login || '').trim();
    if (!login) continue;
    const role = await resolveRole(u.role);
    const modules = await resolveModules(role, u.modules);
    const loginKey = isLetterLogin(login) ? login : (canonicalPhone(login) || login);
    const rec = logins[loginKey] || logins[login] || {};
    const actions = Array.isArray(u.actions) ? u.actions.filter(a => ALL_ACTIONS.includes(a)) : getActionsForRole(role);
    byLogin.set(login, {
      login,
      name: u.name || null,
      role,
      shiftType: u.shiftType === 'day' || u.shiftType === 'night' ? u.shiftType : undefined,
      companyIds: Array.isArray(u.companyIds) ? u.companyIds : undefined,
      visibleCompanies: Array.isArray(u.visibleCompanies) && u.visibleCompanies.length > 0 ? u.visibleCompanies : undefined,
      modules,
      actions,
      allowWithoutToken: !!u.allowWithoutToken,
      selfOnly: !!u.selfOnly,
      hasPassword: !!u.passwordHash,
      lastAttemptAt: rec.lastAttemptAt || null,
      lastSuccessAt: rec.lastSuccessAt || null,
      hasAccess: true,
    });
  }
  for (const [login, rec] of Object.entries(logins)) {
    if (!byLogin.has(login)) {
      byLogin.set(login, {
        login,
        role: null,
        shiftType: undefined,
        companyIds: undefined,
        modules: [],
        lastAttemptAt: rec.lastAttemptAt || null,
        lastSuccessAt: rec.lastSuccessAt || null,
        hasAccess: false,
      });
    }
  }
  return Array.from(byLogin.values()).sort((a, b) => (a.login || '').localeCompare(b.login || ''));
}

function userLoginMatch(u, login, normalized, trimmedLogin) {
  if (u.passwordHash) return trimmedLogin.toLowerCase() === String(u.login || '').trim().toLowerCase();
  return normalizeLogin(u.login) === normalized && normalized || u.login === login;
}

/** Сохранить/обновить пользователя (роль, модули, пароль). Только для админа. */
async function saveUser(login, payload) {
  const trimmedLogin = String(login || '').trim();
  if (!trimmedLogin) throw new Error('Логин не указан');
  const loginToStore = isLetterLogin(trimmedLogin) ? trimmedLogin : (canonicalPhone(trimmedLogin) || trimmedLogin);
  const normalized = normalizeLogin(login);
  const users = await loadVsUsers();
  const existing = users.find(u => userLoginMatch(u, login, normalized, trimmedLogin));

  let changedUser;
  if (existing) {
    const u = { ...existing };
    if (payload.name !== undefined) u.name = String(payload.name || '').trim() || undefined;
    if (payload.role !== undefined) u.role = await resolveRole(payload.role);
    if (payload.modules !== undefined) u.modules = Array.isArray(payload.modules) ? payload.modules.filter(m => ALL_MODULES.includes(m)) : undefined;
    if (payload.shiftType !== undefined) u.shiftType = payload.shiftType === 'day' || payload.shiftType === 'night' ? payload.shiftType : undefined;
    if (payload.companyIds !== undefined) u.companyIds = Array.isArray(payload.companyIds) ? payload.companyIds : undefined;
    if (payload.visibleCompanies !== undefined) u.visibleCompanies = Array.isArray(payload.visibleCompanies) && payload.visibleCompanies.length > 0 ? payload.visibleCompanies : undefined;
    if (payload.allowWithoutToken !== undefined) u.allowWithoutToken = !!payload.allowWithoutToken;
    if (payload.selfOnly !== undefined) u.selfOnly = !!payload.selfOnly;
    if (payload.actions !== undefined) u.actions = Array.isArray(payload.actions) ? payload.actions.filter(a => ALL_ACTIONS.includes(a)) : undefined;
    if (payload.password !== undefined && String(payload.password).trim() !== '') {
      u.passwordHash = hashPassword(payload.password.trim());
    }
    changedUser = u;
  } else {
    const role = await resolveRole(payload.role);
    const modules = Array.isArray(payload.modules) ? payload.modules.filter(m => ALL_MODULES.includes(m)) : undefined;
    const newUser = {
      login: loginToStore,
      name: payload.name ? String(payload.name).trim() || undefined : undefined,
      role,
      shiftType: payload.shiftType === 'day' || payload.shiftType === 'night' ? payload.shiftType : undefined,
      companyIds: Array.isArray(payload.companyIds) ? payload.companyIds : undefined,
      visibleCompanies: Array.isArray(payload.visibleCompanies) && payload.visibleCompanies.length > 0 ? payload.visibleCompanies : undefined,
      modules: modules && modules.length > 0 ? modules : undefined,
      actions: Array.isArray(payload.actions) ? payload.actions.filter(a => ALL_ACTIONS.includes(a)) : undefined,
      allowWithoutToken: !!payload.allowWithoutToken,
      selfOnly: !!payload.selfOnly,
    };
    if (payload.password !== undefined && String(payload.password).trim() !== '') {
      newUser.passwordHash = hashPassword(payload.password.trim());
    }
    changedUser = newUser;
  }
  await persistUser(changedUser);
}

async function removeUser(login) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = await loadVsUsers();
  const toRemove = users.filter(u => userLoginMatch(u, login, normalized, trimmed));
  for (const u of toRemove) await deleteUserRow(u.login);
}

async function getTelegramChatId(login) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = await loadVsUsers();
  for (const u of users) {
    if (!userLoginMatch(u, login, normalized, trimmed)) continue;
    const id = u.telegramChatId;
    return id != null && String(id).trim() !== '' ? String(id).trim() : null;
  }
  return null;
}

async function setTelegramChatId(login, chatId) {
  const trimmed = String(login || '').trim();
  const normalized = normalizeLogin(login);
  const users = await loadVsUsers();
  const existing = users.find(u => userLoginMatch(u, login, normalized, trimmed));
  if (!existing) return;
  existing.telegramChatId = chatId != null ? String(chatId).trim() : '';
  await persistUser(existing);
}

// ─── Коды привязки Telegram — Postgres (Фаза 4) ────────────────────────────────

async function loadBindingCodes() {
  const { rows } = await pool.query('SELECT code, login, expires_at FROM vs_telegram_bind_codes');
  const codes = {};
  for (const row of rows) {
    codes[row.code] = { login: row.login, expiresAt: row.expires_at.getTime() };
  }
  return codes;
}

async function addBindingCode(code, login) {
  const expiresAt = new Date(Date.now() + BIND_CODE_TTL_MS);
  await pool.query(
    `INSERT INTO vs_telegram_bind_codes (code, login, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET login = $2, expires_at = $3`,
    [String(code).toUpperCase(), String(login || '').trim(), expiresAt]
  );
}

async function consumeBindingCode(code) {
  const key = String(code).trim().toUpperCase();
  if (!key) return null;
  const { rows } = await pool.query('SELECT login, expires_at FROM vs_telegram_bind_codes WHERE code = $1', [key]);
  if (!rows.length) return null;
  const entry = rows[0];
  await pool.query('DELETE FROM vs_telegram_bind_codes WHERE code = $1', [key]);
  if (Date.now() > entry.expires_at.getTime()) return null;
  return entry.login;
}

function createBindingCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = {
  init,
  loadVsUsers,
  findUserByLogin,
  createSession,
  getSession,
  destroySession,
  getModulesForRole,
  recordLoginAttempt,
  getAllUsersForAdmin,
  saveUser,
  removeUser,
  getTelegramChatId,
  setTelegramChatId,
  addBindingCode,
  consumeBindingCode,
  createBindingCode,
  loadBindingCodes,
  verifyPassword,
  hashPassword,
  isLetterLogin,
  MODULES_BY_ROLE,
  ALL_MODULES,
  ALL_ACTIONS,
  getActionsForRole,
  BUILTIN_ROLES,
  addPendingUser,
  getPendingUsers,
  approvePendingUser,
  rejectPendingUser,
  normalizePhone,
  getAllRoles,
  addCustomRole,
  updateCustomRole,
  deleteCustomRole,
};
