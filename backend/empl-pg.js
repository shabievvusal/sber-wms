/**
 * empl-pg.js — PostgreSQL-хранилище сотрудников.
 *
 * Таблица employees:
 *   executor_id  TEXT PRIMARY KEY  — UUID из WMS (executorId из часовых JSON)
 *   fio          TEXT NOT NULL     — ФИО сотрудника
 *   company      TEXT DEFAULT ''   — компания / подрядчик
 *   phone        TEXT DEFAULT ''   — номер телефона
 *   password     TEXT DEFAULT ''   — пароль/пин для учётки
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

// ─── Карты соответствия (без кэша) ─────────────────────────────────────────────
// Раньше здесь был in-memory кэш, обновляемый после каждой мутации — убран,
// т.к. с переносом части эндпоинтов на dotnet Node перестал быть единственным
// писателем в эту таблицу и кэш мог рассинхронизироваться. Взамен —
// getLookupMaps(): один свежий SQL-запрос, вызывающий код (server.js) сам
// решает, когда его перечитать (один раз за HTTP-запрос, не за айтем).

async function getLookupMaps() {
  const { rows } = await pool.query('SELECT executor_id, fio, company FROM employees');
  const fioMap = new Map();
  const idMap  = new Map();
  for (const row of rows) {
    const key = normFio(row.fio);
    if (key && !fioMap.has(key)) fioMap.set(key, row.company || '');
    if (row.executor_id) idMap.set(row.executor_id, row.company || '');
  }
  return { fioMap, idMap };
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      executor_id  TEXT PRIMARY KEY,
      fio          TEXT NOT NULL,
      company      TEXT NOT NULL DEFAULT '',
      phone        TEXT NOT NULL DEFAULT '',
      password     TEXT NOT NULL DEFAULT ''
    )
  `);
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT \'\'');
  await pool.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS password TEXT NOT NULL DEFAULT \'\'');
  await pool.query(`CREATE INDEX IF NOT EXISTS employees_fio_idx ON employees (lower(fio))`);
}

// ─── Нормализация ФИО ──────────────────────────────────────────────────────────

function normFio(fio) {
  return String(fio || '').trim().replace(/^-\s+/, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Ключ реестра: "фамилия и" (совпадает с normPkForRegistry в server.js)
function normPkForRegistry(fio) {
  const norm = normFio(fio);
  const parts = norm.split(' ').filter(Boolean);
  if (!parts.length) return norm;
  const init = parts.length > 1 ? parts[1].charAt(0) : '';
  return (parts[0] + ' ' + init).trim();
}

// ─── Чтение ────────────────────────────────────────────────────────────────────

/** Возвращает [{fio, company}] + [companies] */
async function listEmployees() {
  const { rows } = await pool.query('SELECT executor_id, fio, company, phone, password FROM employees ORDER BY fio');
  const employees = rows.map(r => ({
    executorId: r.executor_id,
    fio: r.fio,
    company: r.company || '',
    phone: r.phone || '',
    password: r.password || '',
  }));
  const companySet = new Set(employees.map(e => e.company).filter(Boolean));
  return { employees, companies: [...companySet].sort() };
}

// ─── Запись ────────────────────────────────────────────────────────────────────

/**
 * Добавить или обновить сотрудника.
 * Сотрудники сохраняются только по реальному executor_id.
 */
async function upsertEmployee({ executorId, fio, company, phone, password }) {
  const id = (executorId || '').trim();
  const f  = String(fio || '').trim();
  const c  = String(company != null ? company : '').trim();
  const p  = String(phone != null ? phone : '').trim();
  const pw = String(password != null ? password : '').trim();
  if (!id) throw new Error('executorId обязателен для сохранения сотрудника');
  if (!f) throw new Error('ФИО обязательно');
  await pool.query(
    `INSERT INTO employees (executor_id, fio, company, phone, password)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (executor_id) DO UPDATE SET fio = $2, company = $3, phone = $4, password = $5`,
    [id, f, c, p, pw]
  );
}

/**
 * Добавить сотрудников, которых ещё нет в таблице по executor_id.
 * names — строки ФИО (без компании, взяты из WMS).
 * executors — массив [{executorId, fio}]
 * Возвращает количество новых записей.
 */
async function addNewEmployees(executors) {
  if (!executors || !executors.length) return 0;
  // Получаем существующие записи
  const { rows } = await pool.query('SELECT executor_id, fio FROM employees');
  const existingIds  = new Set(rows.map(r => r.executor_id).filter(Boolean));

  let added = 0;
  for (const { executorId, fio } of executors) {
    const id = (executorId || '').trim();
    const f  = String(fio || '').trim();
    // Без реального UUID — пропускаем (не создаём fio:xxx)
    if (!f || !id) continue;
    // Уже есть с таким реальным UUID — пропускаем
    if (existingIds.has(id)) continue;
    await pool.query(
      `INSERT INTO employees (executor_id, fio, company) VALUES ($1, $2, '')
       ON CONFLICT (executor_id) DO NOTHING`,
      [id, f]
    );
    existingIds.add(id);
    added++;
  }
  return added;
}

/**
 * Обогатить ФИО — заменить краткое имя полным, если в registry есть более длинное.
 * registry — объект { normPk: fullFio }
 * Возвращает количество обновлённых строк.
 */
async function enrichNames(registry) {
  if (!registry || !Object.keys(registry).length) return 0;
  const { rows } = await pool.query('SELECT executor_id, fio FROM employees');
  let updated = 0;
  for (const row of rows) {
    const fullFio = registry[normPkForRegistry(row.fio)];
    if (!fullFio) continue;
    if (fullFio.split(/\s+/).length <= row.fio.split(/\s+/).length) continue;
    const titled = fullFio.replace(/\S+/g, w => w.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-'));
    await pool.query('UPDATE employees SET fio = $1 WHERE executor_id = $2', [titled, row.executor_id]);
    updated++;
  }
  return updated;
}

/** Сохранить весь список сотрудников целиком (заменяет таблицу). */
async function saveAll(employees) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE employees');
    for (const { executorId, fio, company, phone, password } of employees) {
      const id = (executorId || '').trim();
      const f  = String(fio || '').trim();
      const c  = String(company != null ? company : '').trim();
      const p  = String(phone != null ? phone : '').trim();
      const pw = String(password != null ? password : '').trim();
      if (!f || !id) continue;
      await client.query(
        'INSERT INTO employees (executor_id, fio, company, phone, password) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (executor_id) DO UPDATE SET fio=$2, company=$3, phone=$4, password=$5',
        [id, f, c, p, pw]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { init, getLookupMaps, listEmployees, upsertEmployee, addNewEmployees, enrichNames, saveAll };
