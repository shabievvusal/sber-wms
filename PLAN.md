# new zlp-backend — Трек 2, Фазы 0-3 (бэкенд-миграция Node → ASP.NET Core)

> **Объединение репозиториев (2026-07-15)**: по просьбе пользователя
> («нужно объединить папку с бекендом и фронтендом, чтобы я на github
> смог залить проект») фронтенд (`new zlp`) скопирован сюда как подпапка
> `frontend-app/` — эта папка (`new zlp-backend`) теперь единая точка для
> заливки на GitHub. `Dockerfile` (stage `frontend-builder`) и
> `docker-compose.yml` обновлены: вместо доп.контекста на сиблинг-папку
> `../new zlp` — обычный `COPY frontend-app/...` из того же build context.
> `.gitignore`/`.dockerignore` дополнены (node_modules, dist, bin/obj,
> .env). Исходная папка `new zlp` (сиблинг) не удалялась — оставлена как
> есть, но в сборке больше не участвует; `git init`/первый коммит/push на
> GitHub — по решению пользователя делает сам, не через агента. Ниже по
> тексту все упоминания «`new zlp`» относятся к тому, что теперь физически
> лежит в `frontend-app/` этой же папки — исторические записи ниже не
> переписывались.

Песочница для бэкенд-части проекта, сиблинг `zlp-main-main` (read-only
референс) и `new zlp` (фронтенд-песочница). Создана 2026-07-12, потому что
всё, что нужно для Фазы 0 (`backend/`, `docker-compose.yml`, `Dockerfile`),
физически лежит в оригинале, а его трогать нельзя — то же правило, что
действовало весь фронтенд-трек. Файлы скопированы из `zlp-main-main`
(`backend/`, `docker-compose.yml`, `Dockerfile`, `docker-entrypoint.sh`,
`.env.example`, `.dockerignore`, `tools/`), оригинал не менялся.

Разбор по компонентам, порядку исполнения и разведке — см. `PLAN.md`
основного фронтенд-проекта (`new zlp/PLAN.md`, раздел «Трек 2»); здесь —
только то, что конкретно сделано в этой песочнице.

`frontend/app/` (тоже read-only копия из `zlp-main-main`) добавлена
2026-07-12 при первой живой верификации — корневой `Dockerfile` (`node`)
собирает монолит целиком и требует эту папку для сборки фронтенда, раньше
её сюда не копировали (в песочнице до этого работали только с `backend/`).

## Сделано (Фаза 0)

### 1. Reverse-proxy (Caddy)
Новый сервис `caddy` в `docker-compose.yml`, слушает внешний порт (раньше —
`node` напрямую). `Caddyfile` (корень песочницы) — чистый passthrough: всё
уходит на `node:3009`, кроме нового проверочного пути
`/api/dotnet-status` → `dotnet:5080`. Снаружи для существующих клиентов
поведение не меняется. По мере миграции эндпоинтов (Фаза 1+) сюда
добавляются `handle`-блоки на конкретные префиксы — без даунтайма, правкой
только этого файла.

### 2. `vs-sessions.json`/`vs-users.json` → Postgres
- `backend/vs-auth-pg.js` (новый файл) — по образцу `route-rk-pg.js`/
  `empl-pg.js`/`tsd-pg.js`: пакет `pg` напрямую, та же база `zlp`, свои
  таблицы `vs_users`/`vs_sessions`, `CREATE TABLE IF NOT EXISTS` в `init()`.
- **Пересмотрено (2026-07-12): публичный интерфейс модуля теперь ПОЛНОСТЬЮ
  АСИНХРОННЫЙ**, как и у `route-rk-pg.js`/`empl-pg.js`/`tsd-pg.js` — без
  кэша в памяти, каждое чтение реально идёт в Postgres, каждая мутация —
  один атомарный SQL-запрос. Первая версия держала `sessions`/`usersCache`
  в памяти и писала в Postgres в фоне (fire-and-forget) именно чтобы не
  трогать ~60 мест в `server.js` — но по прямому решению пользователя
  («нужен хороший бэкенд на ASP.NET, мы к этому стремимся») сделано
  по-настоящему: все ~60 вызовов `vsAuth.*` в `server.js` переведены на
  `await`, там, где обработчик роута ещё не был `async` — стал им.
  Заодно найдено и исправлено: 4 обработчика (`/api/vs/auth/me`,
  `/api/vs/auth/logout`, `/api/node/sso/login`, `GET /api/node/users`) не
  были обёрнуты в `try/catch` — раньше это было безопасно (запись в файл
  внутри `vs-auth.js` сама глотала ошибки), но с настоящим `await` к
  Postgres необработанный reject в Express 4 без глобального обработчика
  может уронить весь процесс (Node 15+ по умолчанию завершает процесс на
  unhandled rejection) — добавлен `try/catch` по образцу соседних роутов.
- **Единственное осознанно оставленное узкое место**: `saveUser`/
  `setTelegramChatId` — читают текущую строку, мержат в неё только
  переданные поля payload'а и пишут обратно одним upsert'ом. Если один и
  тот же `login` правят два параллельных запроса в пределах миллисекунд —
  один перезапишет правки другого. Это НЕ тот баг, что был раньше (там
  ЛЮБЫЕ два параллельных запроса корёжили ВЕСЬ файл пользователей) — это
  редкий случай «два админа одновременно правят одного и того же
  пользователя», в реальном использовании практически не встречается.
  Альтернатива (мёрж полностью в SQL через `COALESCE`) не выбрана: она не
  может отличить «поле не прислали» от «поле явно очищают» (например,
  обнуление пароля), а это разные случаи в исходной логике. Все остальные
  операции (сессии, удаление, одобрение заявки) — один атомарный запрос,
  без каких-либо гонок.
- Перенесено в Postgres: только сессии и пользователи. Заявки на регистрацию,
  кастомные роли, лог попыток входа, коды привязки Telegram
  (`vs-pending-users.json`/`vs-custom-roles.json`/`vs-logins.json`/
  `vs-telegram-bind.json`) остаются на файлах без изменений — не входили в
  объём Фазы 0.
- `server.js`: `require('./vs-auth')` → `require('./vs-auth-pg')` за флагом
  `USE_PG=true` (тот же, что уже переключает `route-rk-pg.js`); `vsAuth.init()`
  добавлен в существующий `if (process.env.USE_PG === 'true') { ... }` блок
  перед `app.listen()`, рядом с `rkStorage.init()`/`emplPg.init()`/
  `tsdPg.init()`.
- `backend/migrate-vs-json-to-pg.js` (новый, по образцу
  `migrate-json-to-pg.js`) — одноразовый backfill существующих
  `vs-users.json`/`vs-sessions.json` (истёкшие сессии — старше 30 дней —
  пропускаются, не переносятся).
- `docker-compose.yml`: `node`'s bind-mount добавлен для `vs-auth-pg.js`
  (та же live-edit практика, что уже была у `vs-auth.js`).

### 3. Новый `backend-dotnet/`
ASP.NET Core Minimal API, `net9.0` (тот же SDK, что у существующих 5
.NET-тулов), пакет `Npgsql` (первое реальное использование EF/Npgsql в
проекте — существующие тулы к Postgres вообще не подключаются). Один
эндпоинт — `GET /api/dotnet-status`: подключается к той же базе `zlp`,
читает `count(*) from vs_sessions`, возвращает `{ok, service, sessions}`
или `{ok:false, error}` при сбое связи с БД. Никакой бизнес-логики — первый
вертикальный срез (`route-rk-pg.js` → C#) это уже Фаза 1, не здесь.
Свой `Dockerfile` (SDK-сборка → `aspnet:9.0` рантайм), отдельный сервис
`dotnet` в `docker-compose.yml`, порт наружу не публикуется — доступен
только через Caddy (`/api/dotnet-status`) и внутри сети как `dotnet:5080`.

## Верификация

Сделано без Docker-демона (в этом окружении он не запущен):
- Синтаксис всех новых/изменённых JS-файлов (`node --check`) — чисто.
- `docker compose config` — конфигурация полностью резолвится (build-контексты,
  volume-пути, env-переменные, зависимости сервисов) без ошибок.
- Логика `vs-auth-pg.js` вычитана построчно на предмет несостыковок с
  исходным `vs-auth.js` (экспортируемый интерфейс идентичен оригиналу за
  вычетом `VS_USERS_PATH`, который нигде больше не используется — проверено
  grep'ом). Все ~60 мест в `server.js`, вызывающих теперь-асинхронные
  функции (`findUserByLogin`, `getSession`, `createSession`,
  `destroySession`, `getAllUsersForAdmin`, `saveUser`, `removeUser`,
  `addPendingUser`, `approvePendingUser`, `getTelegramChatId`,
  `setTelegramChatId`) — сверены по grep'у на предмет `await`, и каждый
  такой обработчик — на предмет `try/catch` вокруг await (см. пункт про
  4 найденных и исправленных обработчика выше).

**Не сделано (нужно окружение с Docker)**:
- `docker compose up` — реальный подъём `postgres`+`node`+`dotnet`+`caddy`.
- Сквозной прогон логина через Caddy → проверка, что существующие
  `vsSessionRequired`-роуты работают как раньше.
- Рестарт `node`-контейнера → проверка, что сессия/пользователь переживают
  рестарт через Postgres.
- Запуск `migrate-vs-json-to-pg.js` на реальных `vs-users.json`/
  `vs-sessions.json` (в этом чекауте их и нет — `backend/data/` в
  `.gitignore`, не коммитится).
- Обращение к `/api/dotnet-status` через Caddy → подтверждение всей цепочки.

Чтобы закрыть верификацию: поднять Docker Desktop, `cd "new zlp-backend"`,
`docker compose up --build`, затем прогнать сценарии выше вручную (или
попросить меня продолжить в сессии, где Docker-демон доступен).

---

## Фаза 1 (2026-07-12) — route-rk-pg.js → ASP.NET Core, полный перенос

Первый настоящий бизнес-модуль на C# — `backend/route-rk-pg.js` (774 строки,
16 функций) целиком, включая фото/S3 (по решению пользователя — не
откладывали). Данные для уже перенесённой `ShipmentsPage` (`new zlp`).

### Что перенесено

- **Модели** (`Models/`) — `RouteEntity` (EF-сущность на СУЩЕСТВУЮЩУЮ
  таблицу `routes`, ничего не создаёт заново) + POCO для JSONB-вложений
  (`Driver`/`Vehicle`/`CfzAddress`/`Eo`/`ShipmentInfo`/`ReceivingInfo`/`Item`),
  `RouteResponse`/`DriverAggregate`/`CfzAggregate`/и т.д. — DTO ответов,
  повторяющие форму `withTotals()`/`getByDriver()`/`getByCfz()` из оригинала.
- **`Data/AppDbContext.cs`** — JSONB-колонки замаплены через
  `HasConversion` (System.Text.Json, camelCase, те же имена полей, что и в
  Node) + `ValueComparer` (сериализованное сравнение) на каждую из них.
  **Правило, которого придерживается весь `RouteService`**: при обновлении
  JSONB-свойства всегда присваивается НОВЫЙ объект/список, не мутируются
  поля существующего — так смена гарантированно ловится трекингом изменений
  EF по ссылке, независимо от тонкостей ValueComparer.
- **`Services/RouteService.cs`** — все 16 функций оригинала. Архитектурное
  решение: `GetRoutesAsync` (единственная с по-настоящему динамическим
  набором фильтров — status/даты/текст) — сырой SQL через `Npgsql`
  (позиционные `$1,$2,...`), 1-в-1 с оригинальным построением SQL-строки.
  **Все остальные функции** (агрегации по водителям/ЦФЗ, поиск, «недостача
  по датам» и т.д.) — забирают ВСЕ строки через EF (`_db.Routes.
  AsNoTracking().ToListAsync()`, без `.Where()` на JSONB-полях) и
  фильтруют/агрегируют в памяти на C#, тем же способом, что и сам
  route-rk-pg.js в JS. Причина: EF Core не транслирует в SQL доступ к
  вложенным свойствам JSON-конвертированной колонки (`r.Driver.Name == x`
  упал бы в рантайме) — простые null-проверки (`r.Shipment != null`) и
  сравнения по `Date` (не JSONB) остались как `.Where()`, там, где это
  безопасно (`GetDriversWithPendingAsync`/`GetDriversUnshippedAsync`).
  `savePhoto`/`getPhotoPath`/`updateStoreEos` (одиночный вариант) — не
  перенесены: мёртвый код в оригинале (нигде не вызывается из HTTP-слоя).
- **`Services/SessionService.cs`** — аналог `getSession()`/`findUserByLogin()`
  из `vs-auth-pg.js`, читает `vs_sessions`/`vs_users` НАПРЯМУЮ (та же база,
  Фаза 0) — dotnet не ходит в Node за авторизацией. `findUserByLogin`
  воспроизводит ту же нетривиальную логику сопоставления логина (по паролю —
  точное сравнение, иначе — по нормализованному телефону), а не упрощена до
  `WHERE login = $1`, потому что `session.login` не всегда совпадает
  буквально с каноническим логином в `vs_users`.
- **`Services/S3Service.cs`/`PhotoService.cs`** — аналоги `s3.js`
  (`AWSSDK.S3`, тот же кастомный path-style эндпоинт) и sharp-пайплайна
  (`SixLabors.ImageSharp`: `AutoOrient`+`Resize(Max)`+JPEG q80 для основного
  фото, `Resize(Crop)`+JPEG q70 для превью 144×144).
- **`Endpoints/`** — 23 HTTP-эндпоинта (Minimal API), сгруппированы по темам
  (Route/Shipment/Eo/Driver/Photo/Events), гейтинг сессией — `AddEndpointFilter
  <VsSessionRequiredFilter>()` — 1-в-1 повторяет, где в оригинале был
  `vsSessionRequired`, а где эндпоинт был публичным (кладовщик без сессии).
  SSE (`GET /api/rk/events` + широковещание после ship/receive) —
  `Services/SseService.cs`, тот же принцип, что и `sseClients`/`sseNotify` в
  Node, просто теперь в процессе dotnet (раз запись данных происходит здесь).
- **Осознанное исключение**: `POST .../eos/request-refresh` НЕ перенесён —
  трогает не Postgres, а собственное in-memory состояние `server.js`
  (`eoRefreshQueue`, отдаётся через отдельный `/api/status`), не относится к
  домену `route-rk-pg.js`. `Caddyfile` явно роутит именно этот путь на
  `node`, а всё остальное `/api/rk/*` + `/rk-photos/*` — на `dotnet`
  (порядок `handle`-блоков важен: более специфичный путь — первым).
- `docker-compose.yml`: сервис `dotnet` получил `env_file: .env` целиком
  (нужны `S3_*` переменные для фото, не только `PG_*`).

### Известные осознанные отклонения от оригинала (мелкие)

- `ImportedAt`/даты в JSON сериализуются через стандартный формат
  System.Text.Json (7 знаков после запятой + `Z`), а не ровно 3 знака, как
  `Date.prototype.toISOString()` в Node — фронт парсит ISO-строки лояльно,
  не должно ломать отображение, но байт-в-байт не совпадает.
- `getRouteEos`: если у ЦФЗ-адреса нет `storeId` — запись просто
  пропускается, а не заводится под ключом `"null"`/`"undefined"` (как было
  бы при буквальной трансляции JS `result[cfz.storeId]=...` с
  `storeId==null`) — крайне маловероятный кейс на реальных WMS-данных.

### Верификация

Как и в Фазе 0 — без Docker-демона и без установленного .NET SDK в этом
окружении (`dotnet` нет в PATH), поэтому **ни `dotnet build`, ни `docker
compose up` не запускались**. Сделано: построчная сверка каждой C#-функции
с соответствующей функцией `route-rk-pg.js`/эндпоинтом `server.js`
(вычисления, порядок полей, статус-коды, гейтинг сессией — по каждому из
23 эндпоинтов сверено с оригиналом один в один); проверка на типичные
ошибки трансляции EF LINQ→SQL (нигде не осталось `.Where()` на вложенных
свойствах JSON-конвертированных колонок, кроме безопасных null-проверок).

**Нужно доделать руками (или в сессии с доступным Docker + .NET SDK)**:
`dotnet build`/`dotnet restore` — первая реальная проверка, что всё вообще
компилируется; `docker compose up --build`; сквозной прогон через
`ShipmentsPage` (`new zlp`) — список маршрутов, отгрузка/приёмка, вкладки
«По водителям»/«По ЦФЗ», долг рохлей, загрузка фото, SSE-обновление списка,
импорт из WMS.

---

## Фаза 2 (2026-07-12) — tsd-pg.js целиком + часть empl-pg.js → ASP.NET Core,
## убран in-memory кэш из Node (`empl-pg.js`)

### Контекст и решение по объёму

`tsd-pg.js` (выдача ТСД) — самодостаточный модуль, как `route-rk-pg.js`:
все вызовы только из его собственных ~6 роутов в `server.js`, переносится
без оговорок.

`empl-pg.js` держал **in-memory кэш** (`_cache`/`_idCache`), обновляемый
только когда САМ Node писал в таблицу `employees`. С переносом части его
CRUD-эндпоинтов на dotnet Node перестаёт быть единственным писателем в эту
таблицу — кэш мог бы рассинхронизироваться (старая компания в отчётах, пока
Node не перезапустят). **По решению пользователя** («всё равно убрать кэш
сейчас, даже если это ~15 мест») кэш убран насовсем, а не залатан таймером
или инвалидацией через межпроцессное сообщение.

### Что перенесено на dotnet

- **`tsd-pg.js` → `Services/TsdService.cs`** — все 6 функций 1-в-1
  (`ListActiveAsync`/`AssignAsync`/`ReturnByExecutorAsync`/
  `ReturnByTsdAsync`/`GetSettingsAsync`/`SetSettingsAsync`). `AssignAsync`
  воспроизводит транзакцию оригинала (закрыть текущую активную выдачу этого
  ТСД + вставить новую, в одной транзакции). `tsd_settings` (простая
  key-value таблица, одна строка `total_count`) — без EF-сущности, прямой
  SQL через `SqlQueryRaw`/`ExecuteSqlInterpolatedAsync`, как и в оригинале.
  `Data/AppDbContext.cs` — добавлен `DbSet<TsdAssignmentEntity>` на
  существующую таблицу `tsd_assignments` (обычные скалярные колонки, JSONB
  нет).
- **`Endpoints/TsdEndpoints.cs`** — все 6 маршрутов `/api/tsd-assignments*`
  и `/api/tsd-settings`, все требуют сессию (`VsSessionRequiredFilter`) — как
  и в оригинале, без исключений.
- **`empl-pg.js` → частично `Services/EmployeeService.cs`** — только чистый
  CRUD без кэша: `ListEmployeesAsync`, `UpsertEmployeeAsync`,
  `AddNewEmployeesAsync`, `SaveAllAsync` (транзакция TRUNCATE + вставка всех,
  как в оригинале), плюс `ParseCsv` (совместимость со старым
  csv-текстовым форматом `POST /api/employees`). `Data/AppDbContext.cs` —
  добавлен `DbSet<EmployeeEntity>` на существующую таблицу `employees`.
- **`Endpoints/EmployeeEndpoints.cs`** — перенесены 5 маршрутов: `GET/POST
  /api/empl`, `POST /api/empl/add-new`, `GET/POST /api/employees`. Без
  сессии — как и в оригинале (эти роуты у Node тоже публичные).
- **Осознанно НЕ перенесены на dotnet** (остались на Node, попадают туда
  через общий `handle { node }` в Caddyfile): `GET /api/empl/
  find-unregistered` (сканирует `data/*/HH.json` — сырые почасовые файлы
  WMS), `POST /api/empl/enrich-names` (читает `names_registry.json` +
  `data/raw_tmp/*.json`), `POST /api/empl/upgrade-fio-ids` (уже no-op в
  оригинале). Все три читают локальные файлы Node, которые не смонтированы
  в контейнер `dotnet` (`docker-compose.yml` не даёт ему доступа к
  `backend/data/`) — тот же приём, что и с `/eos/request-refresh` в Фазе 1:
  эндпоинт остаётся там, где физически лежит нужное ему состояние.

### Node: снятие кэша (`empl-pg.js`) без async-in-loop и без N+1-запросов

- **`backend/empl-pg.js`** — `_cache`/`_idCache`/`refreshCache()` убраны
  целиком. Взамен — `async function getLookupMaps()`: один SQL-запрос
  (`SELECT executor_id, fio, company FROM employees`), возвращает свежие
  `{ fioMap, idMap }`. `getCompanyById`/`getCompanyByFio` (обёртки над
  кэшем) тоже убраны — их логика (в т.ч. нечёткий подстроковый поиск по
  ФИО) перенесена в сам `server.js` как чистые функции над уже загруженной
  картой.
- **`backend/server.js`** — решение: карта загружается **один раз за
  HTTP-запрос**, а не за айтем, и дальше используется синхронно внутри
  циклов (включая вложенные — `computeCompanyDay`, вызываемая по разу на
  каждый день месяца в `/api/stats/monthly-company`, сама вызывает
  переданный `getComp` синхронно на каждый айтем внутри дня — async-обёртка
  туда не нужна, карта уже готова снаружи).
  - `getEmplMapFioToCompany()` → `async`, делегирует в новую
    `getCompanyLookupMaps()` (PG: `emplPg.getLookupMaps()`; CSV-режим без
    Postgres: старое файловое чтение, вынесено в `getEmplMapFioToCompanyCsv()`
    без изменений логики).
  - `getCompanyByIdOrFio(executorId, executorFio)` заменена на чистую
    `getCompanyByIdOrFioSync(idMap, executorId, executorFio)` — принимает
    уже загруженную карту вместо обращения к глобальному кэшу.
  - Обновлено **15 call sites**: везде перед использованием `getCompany`/
    `getComp`-замыкания или прямого вызова добавлена одна строка `const
    { idMap } = await getCompanyLookupMaps();` (иногда вместе с `fioMap`,
    где нужны обе карты — например, `report2`). Три обработчика, ранее не
    бывшие `async` (`POST /api/stats/placement|receiving|remains/save`,
    `GET /api/stats/monthly-company`, `GET /api/stats/monthly-employees`,
    `GET/PUT /api/consolidation/complaints`), переведены в `async` — та же
    механика, что и в Фазе 0 для `vsAuth.*`.
  - `updateNamesRegistry(items)` (использовалась `emplPg.getCompanyById`
    внутри) тоже стала `async`; её 4 вызова (`/api/save-fetched-data` +
    3 `/api/stats/*/save`) обновлены на `await`.
- `docker-compose.yml`: изменений не потребовалось — сервисы `dotnet`
  привязаны к той же базе `zlp`, что и `node` (Фаза 0), новые таблицы
  `tsd_assignments`/`employees` уже существовали (создаются `init()` в
  `tsd-pg.js`/`empl-pg.js`, которые остаются в Node — dotnet только читает/
  пишет по готовой схеме, как и `routes` в Фазе 1).
- `Caddyfile`: добавлены `handle`-блоки `/api/tsd-assignments*`,
  `/api/tsd-settings*`, `/api/empl` (точный путь, без `*` — только
  `GET`/`POST /api/empl`, без подпутей), `/api/empl/add-new`,
  `/api/employees` → `dotnet:5080`. Три Node-only под-роута `/api/empl/*`
  (см. выше) явных блоков не получили — попадают в `handle { node }` по
  умолчанию, порядок это позволяет (нет пересечения путей).

### Верификация

Как и в Фазах 0-1 — без Docker-демона и без .NET SDK в этом окружении:
`node --check` на `server.js`/`empl-pg.js`/`tsd-pg.js` — чисто. Построчно
перечитаны все 15 изменённых call sites в `server.js` целиком (не только
diff) — это было явно оговорено заранее как самая рискованная правка в
бизнес-критичном файле за всю сессию (полтора десятка мест в статистике/
нарушениях/консолидации). Построчная сверка C#-кода (`TsdService`,
`EmployeeService`, эндпоинты, `AppDbContext`) с оригиналом — вручную, без
компилятора.

**Нужно доделать руками**: `dotnet build`/`docker compose up --build`;
сквозной прогон выдачи ТСД (страница «Выдача ТСД») и справочника
сотрудников (страница настроек) через Caddy; проверка, что статистика
(`/api/stats/*`, `/api/date/*/summary`, консолидация) по-прежнему
корректно резолвит компанию — теперь без кэша, при каждом запросе живым
SQL-запросом.

---

## Живая верификация (2026-07-12) — Docker Desktop оказался доступен

После Фазы 2 в рабочем окружении неожиданно обнаружился запущенный Docker
Desktop (раньше во всех трёх фазах его не было — весь C#-код писался и
проверялся только построчным ревью, без единой реальной компиляции). Раз
появилась возможность — сделан первый настоящий `docker compose up --build`
и сквозной прогон через Caddy. Дословно: **это первый раз за все три фазы,
когда C#-код вообще скомпилировался**, и ревью само по себе не поймало все
проблемы ниже — их поймало только реальное выполнение.

### Найдено и исправлено 3 реальных бага

1. **Конфликт версий NuGet-пакетов (блокировал сборку целиком)** —
   `backend-dotnet.csproj` жёстко пиновал `Npgsql` 8.0.5 и
   `Microsoft.EntityFrameworkCore` 9.0.0, а `Npgsql.EntityFrameworkCore.
   PostgreSQL` 9.0.4 требует `Npgsql >= 9.0.3` и `EntityFrameworkCore >=
   9.0.1` — NU1605 (downgrade error), сборка падала на `dotnet restore` ещё
   до компиляции хоть одной строчки кода. Поднял версии до `Npgsql` 9.0.3 /
   `Microsoft.EntityFrameworkCore` 9.0.4.
2. **`SqlQueryRaw<T>` для скалярных типов требует колонку с именем ровно
   `"Value"`** (особенность EF Core 9, не задокументированная в коде) — обе
   raw-SQL-джапросы через `SqlQueryRaw<long>`/`SqlQueryRaw<string>`
   (`/api/dotnet-status` из Фазы 0/1 — `SELECT count(*) FROM vs_sessions`, и
   `TsdService.GetSettingsAsync()` из Фазы 2 — `SELECT value FROM
   tsd_settings ...`) падали в рантайме с `42703: column s.Value does not
   exist`, хотя выглядели совершенно невинно и прошли построчное ревью в обеих
   фазах. Исправлено алиасом: `SELECT ... AS "Value"`.
3. **`RouteService.cs`: `private static readonly CultureInfo Ru = new
   ("ru-RU")` падал при загрузке типа** (`TypeInitializationException`),
   потому что `.csproj` включал `<InvariantGlobalization>true</
   InvariantGlobalization>` — без реальных ICU-культур доступна только
   invariant-культура, `new CultureInfo("ru-RU")` кидает
   `CultureNotFoundException`. Ронял ВСЕ маршруты, которые сортируют
   по-русски (`/api/rk/drivers`, `/api/rk/cfz`, `driver-rokhlya-debt` и
   т.д.) — то есть без этого фикса Фаза 1 была нерабочей в проде целиком,
   несмотря на то, что построчное ревью её одобрило. Исправлено: убран
   `InvariantGlobalization` (нужны настоящие культуры ради
   `localeCompare('ru')`-эквивалентного сравнения — это сознательный выбор
   в пользу верности оригиналу, а не обход бага заменой на
   `OrdinalIgnoreCase`).

Вывод для дальнейшей работы: построчное ревью C# без компилятора — это
подстраховка, а не замена реальной сборки; все три найденных бага были
именно того рода, что ревью в принципе не может поймать (версии пакетов,
рантайм-поведение конкретной версии EF Core, поведение глобализации).

### Что реально прогнано и подтверждено работающим

Стек поднят целиком (`postgres`+`node`+`dotnet`+`caddy`) с `USE_PG=true`
(в `.env` этой песочницы стояло `false` по умолчанию — переключено на
`true` для теста, так и оставлено). `frontend/app/` скопирован из
`zlp-main-main` — без него `node`-образ не собирался (Dockerfile монолита
требует папку фронтенда).

- `GET /api/dotnet-status` — `{"ok":true,...}` после фикса №2.
- **Фаза 2 (TSD)**: `assign` (включая транзакцию — назначение того же ТСД
  другому исполнителю автоматически закрывает предыдущую активную выдачу),
  `return` (по исполнителю), `return-tsd` (включая `foreignReturn: true`,
  когда возвращает не тот, кому выдано, и корректный `null` при повторном
  возврате уже закрытого ТСД), `GET/PUT /api/tsd-settings`, гейтинг сессией
  (401 без `vs_sid`), валидация (`400` без обязательных полей) — всё
  проверено вручную через `curl` с настоящей строкой в `vs_sessions`.
- **Фаза 2 (Employees)**: `GET/POST /api/empl`, `GET /api/employees` —
  создание/чтение сотрудника с кириллицей в ФИО прошло корректно
  (round-trip через JSON с camelCase-полями).
- **Фаза 1 (Routes)**: `POST /api/rk/import-bulk` с реалистичным
  WMS-JSON (маршрут, водитель, ТС, 2 ЦФЗ-адреса с ЭО) — успешный импорт;
  `GET /api/rk/routes/:id` — JSONB (`driver`/`vehicle`/`cfzAddresses`)
  корректно сериализуется обратно 1-в-1; `POST .../ship` — обновление
  JSONB `shipment` (со сменой ссылки на новый объект, как и требует правило
  из `AppDbContext.cs`) и пересчёт `WithTotals` (`shippedRK`/`shippedPallets`/
  `shippedBoxes`/`shippedThermalCovers`/`rokhlyaDebt`) — все числа сошлись
  вручную; `GET /api/rk/drivers`/`GET /api/rk/cfz` — агрегация и сортировка
  по-русски (после фикса №3, «Вторая» встала раньше «Тестовая» — корректный
  кириллический порядок); `GET /api/rk/driver-rokhlya-debt` — `debtSince`
  (дата+номер маршрута) посчитан верно.
- Все тестовые данные (session/route/employees/tsd-записи), созданные для
  проверки, удалены из БД после прогона — песочница осталась чистой.

### Вторая волна живой верификации (тот же день, продолжение)

Добавил в `vs_users` настоящую строку (`test-admin`) — понадобилась для
`confirm-ship`/`confirm-receive` (резолвят `confirmedBy` через
`FindUserByLoginAsync`, фейковой сессии без пользователя недостаточно).

- **`confirm-ship`/`confirm-receive`** — `confirmedBy` корректно
  зарезолвился в `"test-admin"` (fallback на `session.Login`, т.к. у
  тестового логина нет цифр для нормализации телефона — `FindUserByLoginAsync`
  законно не нашёл совпадение). Сверил с оригиналом (`server.js:3744-3758`,
  `user?.name || login`) — 1-в-1 та же логика fallback'а, не баг.
- **Приёмка (`receive`)** — `diff`/`rokhlyaDebt` пересчитались верно
  (`shippedRK==receivedRK ⇒ diff:0`; `rokhlyaDebt = shipped.rokhlya -
  received.rokhlya = -1`).
- **`GET /api/rk/routes`** с реальными фильтрами — `q=` (поиск по ФИО
  водителя), `dateFrom`/`dateTo`, `status=shipped` — все три варианта
  динамического raw-SQL (`GetRoutesAsync`/`QueryRoutesRawAsync`) вернули
  правильный маршрут.
- **`DELETE /api/rk/routes/bulk`** (по id) и **`DELETE /api/rk/routes`**
  (по диапазону дат) — оба отработали, второй реально удалил маршрут
  (`deleted: 1`), после чего список пуст.
- **`/api/empl/add-new`** (формат `executors`) и **`POST /api/employees`**
  оба формата — массив (`{employees:[...]}`, транзакция TRUNCATE+вставка —
  предыдущие строки корректно исчезли после `saveAll`) и CSV-текст
  (`{csv:"..."}` — подтвердил вживую, что это воспроизводит известную
  особенность оригинала: `ParseCsv` не проставляет `executorId`, `saveAll`
  пропускает строки без id, поэтому TRUNCATE происходит, а вставки — нет;
  это тот же результат, что дал бы оригинальный Node-код в PG-режиме на
  таком же вводе, не баг).
- По пути поймал две проблемы со своими же тестовыми командами (не с
  кодом): `printf '\n'` в bash-эвристике превратил экранированный перевод
  строки в СЫРОЙ внутри JSON-строки (невалидный JSON → закономерный 400);
  и путь `/tmp/...`, созданный через `Write`, не совпадал с `/tmp` внутри
  Bash-инструмента на Windows — пришлось писать через явный scratchpad-путь.
  Оба — артефакты тестовой обвязки, не находки по продукту.

### Третья волна — статистика/консолидация (сердце Фазы 2) + найден 4-й баг

Самая рискованная правка сессии (снятие кэша из `empl-pg.js`, 15 call sites
в `server.js`) до этого момента была проверена только ревью — воспроизвёл
почасовые WMS-данные вручную (синтетический файл `data/2026-07-12/10.json`
внутри контейнера node — `DATA_DIR` не забиндмаунчен на хосте, том
`node-persist`), добавил сотрудника с `executorId`, совпадающим с
`executorId` в файле, и прогнал через реальный HTTP весь путь
`getCompanyLookupMaps()`/`getCompanyByIdOrFioSync()`.

**Баг №4 (инфраструктурный, не в C#/JS-коде)**: между прошлой и этой волной
верификации `node` вообще перестал отвечать через Caddy (`connection
refused`, при этом сам процесс внутри контейнера был жив и здоров —
собственный healthcheck через `localhost` проходил). Причина: `.env`
хранит `PORT=3007` для ВНЕШНЕГО (хост-фейсинг) маппинга caddy
(`"${PORT:-3009}:3009"`), но `env_file: .env` у сервиса `node` в
`docker-compose.yml` протекает ту же переменную ВНУТРЬ контейнера, а
`server.js` слушает именно `process.env.PORT` — то есть node слушал 3007
вместо жёстко зашитого в `Caddyfile` `node:3009`. Подтверждено дампом
`/proc/net/tcp` внутри контейнера (слушающий сокет на `0BBF`=3007, ничего
на `0BC1`=3009) и `ping`/`wget` из контейнера caddy (ICMP проходит, TCP
на 3009 — `connection refused`). Похожая на первый взгляд конструкция есть
и в оригинале `zlp-main-main/docker-compose.yml` (там раньше сам `node`
был внешним сервисом, `"${PORT:-3009}:3009"` — тот же паттерн), но там
`PORT` из `.env` совпадал с портом при использовании значения по умолчанию;
проблема стала заметна именно после введения Caddy (Фаза 0 этого трека),
когда порт node из внутреннего стал ФИКСИРОВАННЫМ (`3009`, жёстко в
Caddyfile), а внешний — настраиваемым через `.env`, и эти два смысла
`PORT` разъехались. Исправлено: явный `environment: - PORT=3009` у
сервиса `node` в `docker-compose.yml` (explicit `environment` в Compose
имеет приоритет над `env_file`), декоррелирует внутренний порт node от
внешнего порта caddy. Проверено: `docker compose up -d --force-recreate
node` → `PORT=3009` внутри контейнера → `/api/status` отвечает 200 через
Caddy; рестарт контейнера — снова отвечает (не разовая случайность).

После фикса подтверждено вживую:
- **`GET /api/date/:date/items`** — фильтр по `session.companyIds`/
  `user.visibleCompanies` (использует `getCompanyByIdOrFioSync`) отработал.
- **`GET /api/date/:date/summary?shift=day`** — `companySummary.rows` и
  `hourlyByEmployee.rows` корректно показали `company: "ООО СтатТест"`,
  зарезолвленную через `getCompany` из свежей `idMap` (без кэша) — это и
  есть центральная проверка всей правки Фазы 2.
- **`GET /api/stats/monthly-company`** и **`GET /api/stats/
  monthly-employees`** — оба тоже верно показали компанию по каждому
  сотруднику/агрегату.
- **`PUT /api/consolidation/complaints/:id/lookup`** — компания
  зарезолвилась через `getCompanyByFio(await getEmplMapFioToCompany(), ...)`
  корректно (`"ООО СтатТест"`), подтверждая, что `getEmplMapFioToCompany()`
  и `getCompanyByFio` (обе части снятия кэша) работают вместе правильно.
- По пути поймал две проблемы со своими же тестовыми командами (не с
  кодом): `printf '\n'` в bash-эвристике превратил экранированный перевод
  строки в СЫРОЙ внутри JSON-строки (невалидный JSON → закономерный 400);
  путь `/tmp/...`, созданный через `Write`, не совпадал с `/tmp` внутри
  Bash-инструмента на Windows; и кириллица, напрямую вписанная в
  bash-команду (`curl -d '{"...кириллица..."}'`), дважды приходила
  побитой (mojibake) — везде фикс один: писать JSON-тело через `Write` в
  scratchpad-путь и слать `--data-binary @file`, а не инлайнить в команду.

### Четвёртая волна — PATCH .../driver и SSE

- **`PATCH /api/rk/routes/:routeId/driver`** — обновление JSONB `driver`
  (новый объект-ссылка) отработало, гейтинг сессией подтверждён (401 без
  cookie).
- **SSE (`GET /api/rk/events`)** — открыл живое соединение через `curl -N`,
  получил `data: connected`, затем `POST .../ship` на другом маршруте дал
  `event: routes-updated` на этом же открытом соединении — широковещание
  работает. Отдельно проверил и задокументировал: `PUT .../ship` (правка,
  не первичная отгрузка) НЕ шлёт SSE-уведомление — это НЕ баг переноса, а
  1-в-1 повторение оригинала (`server.js:3677-3707` — `sseNotify` стоит
  только в `POST .../ship` и `POST .../receive`, ни в одном `PUT`/`PATCH`/
  `confirm-*` маршруте его нет и там).

### Ещё не проверено (осталось на следующий раз)

Фото/S3-загрузка (`PhotoService`/`S3Service`, `ImageSharp`+`AWSSDK.S3`) —
единственный совсем непроверенный кусок Фазы 1. Нужен реальный
S3-совместимый сервер (MinIO/RustFS); пользователь решил отложить —
проверить позже на реальном сервере с настоящим S3, не поднимать
временный MinIO в этой сессии.

---

## Фаза 3 (2026-07-12/13) — storage.js (статистика/агрегации) → ASP.NET Core + Postgres

Самая крупная фаза за весь трек — по объёму бизнес-логики сопоставима с
Фазой 1, но с большей концентрацией риска в одной функции
(`buildSummaryFromItems`). Разведка (Explore-агент) нашла важный факт:
для этого домена УЖЕ шла миграция, но другим путём — 5 .NET CLI-тулов
(`tools/SaveFetchedData`/`ArticleSpeeds`/`EmployeePerformance`/
`MissingWeightRebuild`/`WeightScan`), вкомпилированных в сам `node`-образ,
вызываемых через `execFileAsync`, читающих/пишущих `backend/data/*.json`
напрямую, без Postgres. **Пользователь подтвердил решение продолжать по
установленному для Фаз 0-2 пути** (ASP.NET Core + Postgres, не CLI-тулы),
**сразу для всех 4 доменов** `storage.js` (ops/placement/receiving/remains).
`build-dashboard-summary.js` не вызывается ни из одного HTTP-роута (только
фоновый `data-collector.js`) — в объём Фазы 3 не входил.

### Архитектурная развилка и решение: дуал-райт для ops

4 CLI-тула (`ArticleSpeeds`/`WeightScan`/`MissingWeightRebuild`/
`EmployeePerformance`) читают **только** `data/<date>/HH.json` (ops-домен).
Полный cutover сломал бы их. Решение: **Node продолжает писать JSON-файлы
как раньше** (через `tools/SaveFetchedData`, без изменений) **и
дополнительно** пересылает те же raw-items в новый внутренний эндпоинт
`POST /api/stats/ops/ingest` на `dotnet:5080` (прямой вызов
контейнер-контейнер, НЕ через Caddy — эти `/ingest`-пути не проксируются
наружу вообще). Тот же приём применён к `POST /api/stats/{placement,
receiving,remains}/save` — не потому что их JSON читают CLI-тулы (не читают),
а потому что эти же роуты в Node попутно вызывают `updateNamesRegistry()`
(обнаружение новых сотрудников, файловый `names_registry.json`/`empl.csv`,
отдельная от Postgres логика) — полный cutover на dotnet тихо потерял бы
`newEmployees` в ответе. Ошибка дуал-райта (fetch к dotnet) не валит
основной ответ — JSON-файлы остаются единственным source of truth для
существующих CLI-тулов, что бы ни случилось с Postgres-веткой.

Читающие эндпоинты (`GET /api/date/*`, `/api/shifts*`, `/api/analysis/
employee-rates`, `/api/stats/monthly-company`, `/api/stats/monthly-employees`,
`/api/stats/{placement,receiving,remains}/monthly-employees`, `GET
/api/product-weights`) переехали на dotnet целиком через Caddy — без
дуал-райта (чистое чтение, дуал-райт нужен только на write-стороне).

### Схема (4 новые таблицы + product_weights + wms_storage_agg)

- **`wms_ops`** — «light item» (аналог `toLightItem()`), `UNIQUE(date, hour,
  merge_key)`, дедуп «первый выигрывает» — как в `loadHourly`/merge оригинала.
- **`wms_placement`/`wms_receiving`/`wms_remains`** — структурно похожи, но
  **семантика повторной записи — слияние полей**, не «первый выигрывает»:
  новые данные перекрывают старые везде, КРОМЕ `executorId`/`executor`/
  `targetCellsAddresses`/`skuCount`/`eoCount` — там «новое, если непусто,
  иначе старое» (1-в-1 с `savePlacementItems`/`saveReceivingItems`/
  `saveRemainsItems` в оригинале). `getRemainsSummary` **переиспользует**
  `buildPlacementSummary`, а не отдельную `buildRemainsSummary` — повторено
  так же в C# (`RemainsAsPlacement`-адаптер), это поведение оригинала,
  не баг переноса.
- **`product_weights`** — Excel остаётся на Node (`product-weights.js`, парсинг
  `xlsx`-пакетом, без нужды добавлять Excel-библиотеку в .NET), но
  `saveExcelBuffer`/`deleteExcel` теперь ЗЕРКАЛЯТ содержимое в эту таблицу
  (fire-and-forget, не блокирует upload-ответ — таблица весов меняется редко,
  в отличие от кэша сотрудников Фазы 2, который был на каждом запросе).
  dotnet читает её свежим запросом на каждый вызов, без кэша.
- **`wms_storage_agg`** — для `POST /api/date/:date/storage`; `getStorageForDate`
  (чтение обратно) — подтверждённый мёртвый код в оригинале (нет вызывающих),
  таблица сохранена только для полноты записи.
- Легаси `data/shift_*.json` (полный, не light формат) — перенесены
  бэкфиллом через `toLightItem`/`getMergeKey`-эквивалент; после бэкфилла
  legacy-fallback в C#-порте `GetDateItemsAsync` не нужен — Postgres
  единственный источник и для старых, и для новых дат.

### `backend-dotnet/` — новые модули

- `Models/StatsModels.cs` — сущности всех 4 доменов + `product_weights` +
  `wms_storage_agg` + `HourlyByEmployeeResult`/`DateSummaryResult` (эти два
  типизированы отдельно от остальных loosely-typed полей сводки, потому что
  `GetEmployeeRatesAsync` читает `hourlyByEmployee.rows` обратно — держать
  как `object` потребовало бы `dynamic`/даункаст на каждый доступ).
- `Services/StatsService.cs` (~1600 строк — крупнейший файл трека) — порт
  `getDateItems`/`buildSummaryFromItems` (приоритет №1 по тщательности сверки
  — доминирующая зона/операция по взвешенному скору 0.5×count-share +
  0.5×weight-share, КДК/заморозка/хранение классификация по зонам `KDM`/`MH`,
  простои по границам смены), `listShifts` (переписан на `GROUP BY date, hour`
  вместо сканирования файлов — legacy-fallback больше не нужен),
  placement/receiving/remains аналоги, `GetEmployeeRatesAsync`/
  `GetMonthlyCompanyAsync`/`GetMonthlyEmployeesAsync` (1-в-1 порт, включая
  один найденный по пути нюанс — см. ниже), компания резолвится НАПРЯМУЮ в
  C# (`GetIdMapAsync()`/`ResolveCompany()`, один запрос на HTTP-запрос — тот
  же принцип, что закреплён в Фазе 2, но теперь без похода в Node, поскольку
  dotnet уже владеет таблицей `employees`).
- `Endpoints/StatsEndpoints.cs` — ~20 маршрутов + 4 внутренних `/ingest`
  (не в Caddyfile). Гейтинг сессией и её опциональное чтение (аналог
  `vsSessionOptional`) сверены с оригиналом по каждому роуту —
  `SessionService` (Фаза 1) расширен полями `ShiftType`/`CompanyIds`
  (`vs_sessions`) и `SelfOnly`/`VisibleCompanies` (`vs_users`), которых
  раньше не требовалось (Route/Tsd/Employee-домены их не использовали).
- **Найденный по пути баг оригинала, воспроизведённый намеренно**:
  `getDateSummary` (storage.js:1356-1361) вызывает `context.getCompany(it.
  executor)` ОДНИМ аргументом, хотя `getCompany = (fio, id) => ...`
  ожидает `executorId` вторым — значит `id` всегда `undefined`, `company`
  всегда `null`, и фильтр по `filterCompanies` внутри `getDateSummary`
  реально ВСЕГДА обнуляет items, если задан (у `getPlacementSummary`/
  `getReceivingSummary`/`getRemainsSummary` тот же фильтр вызывает
  `getCompany(it.executor, it.executorId)` — 2 аргумента, без этой
  проблемы). Порт (`GetDateSummaryAsync`) воспроизводит эту особенность
  один в один — не наша задача тихо чинить баги при переносе.
- `migrate-storage-json-to-pg.js` (новый, по образцу `migrate-json-to-pg.js`)
  — идемпотентная схема, батчи, upsert `ON CONFLICT DO UPDATE`, per-row
  try/catch. Обходит `data/<date>/{*.json, placement/, receiving/, remains/}`
  + легаси `shift_*.json` + `product-weights.xlsx`.

### Верификация

Docker доступен в этом окружении — сделан реальный `docker compose build`+
`up`, а не только ревью:
1. **`dotnet build`** — нашлась реальная ошибка компиляции: C# именованные
   `ValueTuple` теряют имена полей в тернарном операторе, когда один из
   веток — безымянный tuple-литерал (`dict.TryGetValue(k, out var v) ? v :
   (0,0,0)` — компилятор унифицирует тип к БЕЗЫМЯННОМУ `(int,int,int)`).
   Нашлось 6 таких мест в `buildSummaryFromItems`/`GetMonthlyCompanyAsync`/
   `GetEmployeeRatesAsync` — исправлено явной типизацией переменной слева
   (`(int A, int B) x = ... ? v : (0,0);`). Билд прошёл чисто со второй
   попытки.
2. **Бэкфилл-скрипт** прогнан на чистой (пустой) базе — идемпотентно создал
   все 5 новых таблиц, 0 ошибок (реальных исторических JSON-данных в этом
   чекауте нет).
3. **Живой прогон через реальный дуал-райт**: `POST /api/save-fetched-data`
   с реалистичным сырым WMS-JSON (2 операции, КДК+хранение, один
   исполнитель) → подтверждено, что (а) `tools/SaveFetchedData` по-прежнему
   пишет `data/<date>/<HH>.json` в прежнем формате (проверено чтением файла
   из контейнера — байт-в-байт то же, что раньше), и (б) те же raw-items
   долетели до `dotnet:5080/api/stats/ops/ingest` и стали доступны через
   `GET /api/date/:date/items|summary` — **включая саму `buildSummaryFromItems`**:
   верно посчитаны `totalOps`/`totalQty`, час корректно сдвинут по Москве
   (`10:xx UTC → hour 13`), КДК/хранение классификация по зоне, доминирующая
   зона в `hourlyByEmployee` (`byHourZone`), вес по `product_weights`
   (найденный артикул → `weightKdkGrams`, ненайденный → `missingWeightNames`),
   резолв компании через новую бескэшевую Postgres-таблицу, простои по
   границам смены (`idlesByEmployee`).
4. Аналогично прогнаны и подтверждены рабочими: **placement** (сохранение +
   `hourlyByEmployee`), **receiving** (включая отдельный счётчик `secondary`/
   `eoCount`), **remains** (включая переиспользование `buildPlacementSummary`),
   `GET /api/shifts`/`GET /api/shifts/current`, `GET /api/stats/
   monthly-company` (агрегация по компании с весами), `GET
   /api/product-weights`.
5. Тестовые данные (Postgres-строки + тестовые JSON-файлы за тестовую дату)
   удалены после прогона — песочница чистая.

**Не сделано** (не было ни формального fixture-diff теста «тот же JSON
через оригинальную JS-функцию и через C#, построчное сравнение» — заменён
на прямой прогон реалистичных данных через реальный HTTP-стек с ручной
проверкой каждого поля результата, что нашло бы те же расхождения; **не
проверено**: `GET /api/analysis/employee-rates` (композиция поверх уже
проверенного `GetDateSummaryAsync`, не прогнан отдельно), `POST /api/date/
:date/storage` (`wms_storage_agg`, некритичный мёртво-читаемый эндпоинт),
и полноценный прогон с историческими данными через бэкфилл-скрипт (нет
реальных `data/*.json` в этом чекауте, чтобы это проверить).

## Фаза 4 (2026-07-12/13) — vs-auth.js/server.js (аутентификация) → ASP.NET Core + Postgres

Названа самим пользователем «последней и самой рискованной» — от неё
зависит доступ ко всему остальному приложению. Разведка нашла, что Фаза 0
уже перенесла САМОЕ рискованное (сессии/пользователи, `vs_sessions`/
`vs_users`, полностью асинхронно, без кэша); настоящий объём этой фазы —
то, что Фаза 0 сознательно отложила: **4 файловых поддомена** (кастомные
роли, заявки на регистрацию, лог попыток входа, коды привязки Telegram) +
**сама логика входа** (`samokatLogin` — внешний HTTP к Samokat WMS API,
4-ветвистая логика `/api/vs/auth/login`). **Пользователь подтвердил: весь
объём сразу** (как в Фазе 3), явно исключив из объёма: `/api/node/*`
(kill-switch/destroy/SSO, `destroy` физически удаляет проект на хосте —
обсудим отдельно) и ~1300 строк мёртвого кода в `server.js` (оставлены как
есть, уберём отдельным заходом).

### Что переехало на dotnet, что осталось на Node — принцип разделения

**Переехали на `backend-dotnet` (Caddy проксирует целиком, Node-версии —
мёртвый код, как в Фазах 1-3):** `POST /api/vs/auth/register`, `POST
/api/vs/auth/login` (вся 4-ветвистая логика + `samokatLogin`), `GET /api/vs/
auth/me`, `POST /api/vs/auth/logout`, `GET/POST/PUT/DELETE /api/vs/admin/
roles*`, `GET/POST/DELETE /api/vs/admin/pending*`, `GET/PUT/DELETE /api/vs/
admin/users`.

**Остались на Node (осознанно):** `GET /api/vs/telegram/status`, `POST
/api/vs/telegram/bind-start` — зависят от общего `config.json` приложения
(Telegram Bot Token) и живого HTTP к Telegram Bot API; переносить весь
`config.json` в Postgres — отдельная фаза, сильный scope creep. Consumer-
цикл кодов привязки (`telegramBindingPollingLoop`, long-poll к Telegram
`getUpdates`) — фоновый процесс, не HTTP-роут; в Minimal API пока нет
паттерна background worker (request-driven только) — вводить его сейчас
было бы отдельным архитектурным решением, не «просто перенести код».
Остаётся на Node, читает/пишет ту же Postgres-таблицу кодов, что и dotnet
мог бы читать. `/api/node/*` — по решению пользователя.

### `backend/vs-auth-pg.js` — тоже требует правки (не только dotnet)

Node продолжает владеть ролями/заявками/логами/bind-кодами (нужны для
`/api/node/*` и `/api/vs/telegram/*`), но их реализация меняется с
файлов на Postgres (`vs_custom_roles`/`vs_pending_users`/`vs_logins`/
`vs_telegram_bind_codes`, те же 4 новые таблицы, что и в схеме ниже).
Ripple-эффект: роли переплетены почти везде — `isValidRole`/`resolveRole`/
`getModulesForRole`/`resolveModules` были синхронными (читали файл
синхронно), вызывались ВНУТРИ `findUserByLogin`/`createSession`/
`getAllUsersForAdmin`/`saveUser`/`approvePendingUser` — все стали `async`,
`await` протянут через все внутренние вызовы, а затем — через все call
site'ы в `server.js` (~20 мест: `/api/vs/auth/login` — 8 вызовов
`recordLoginAttempt`, 4 `getModulesForRole`, 1 `getPendingUsers`; `/api/vs/
auth/me` — 1 `getModulesForRole`; админ-роуты ролей/заявок — 6 мест;
Telegram bind-start/consumer-loop — `addBindingCode`/`consumeBindingCode`).
Перечитан весь изменённый файл (740 строк) и все задетые участки
`server.js` целиком после правки (не только diff) — та же дисциплина, что
и в Фазе 0/2 для похожего ripple. Один самоисправленный баг по пути:
`Edit` при конвертации `loadLogins` оставил осиротевший `try` без `catch`
(смесь старого/нового кода) — пойман чтением файла сразу после правки,
исправлен до `node --check`.

### ⚠️ Критический риск: scrypt-совместимость паролей (пройден до старта остального кода)

`hashPassword`/`verifyPassword` в Node — `crypto.scryptSync(password, salt,
64)`, дефолты N=16384, r=8, p=1. В .NET нет встроенного scrypt. Первая
гипотеза плана — пакет `Konscious.Security.Cryptography.Scrypt` — **не
существует** (проверено чтением реального README на GitHub
`kmaragon/Konscious.Security.Cryptography`: библиотека реализует только
Blake2 и Argon2, scrypt там нет вообще). Найден и подтверждён реальный
пакет через прямой запрос к NuGet registry API
(`azuresearch-usnc.nuget.org/query?q=scrypt`): id **`SCrypt`**, v2.0.0.2
(CryptSharp-производный, James F. Bellinger, 6M+ скачиваний),
`SCrypt.ComputeDerivedKey(passwordBytes, salt, 16384, 8, 1, null, 64)`.
Перед написанием остального кода — изолированный одноразовый Docker-тест
(`dotnet run` в `mcr.microsoft.com/dotnet/sdk:9.0` с реальным
Node-сгенерированным хэшем) подтвердил **байт-в-байт идентичный результат**.
Пакет таргетит .NET Framework (не netstandard/net9 нативно) — работает
через совместимость, ожидаемое предупреждение сборки `NU1701`.
Живой прогон (см. «Верификация» ниже) подтвердил совместимость ещё раз —
уже на реальном сквозном пути (register на dotnet → approve → login на
dotnet), а не только в изолированном тесте.

### Схема — 4 новые таблицы

`vs_custom_roles(key PK, label, modules jsonb)`, `vs_pending_users(id
BIGSERIAL PK, name, phone, wms_phone, site_password_hash, registered_at,
status, normalized_phone UNIQUE)`, `vs_logins(login_key PK, last_attempt_at,
last_success_at)`, `vs_telegram_bind_codes(code PK, login, expires_at)`.
Создаются в `init()` обоих модулей (`vs-auth-pg.js` уже вызывает его при
старте Node — dotnet ничего не создаёт сам, только читает/пишет уже
существующие таблицы, тот же принцип, что и с `vs_users`/`vs_sessions` в
Фазе 0). Бэкфилл — `migrate-vs-auth-files-to-pg.js` (идемпотентный,
upsert, per-row try/catch, истёкшие Telegram-коды не переносятся — тот же
принцип, что и с истёкшими сессиями в Фазе 0).

### `backend-dotnet/` — новые модули

- `Models/AuthModels.cs` — `AuthVsUser`/`AuthVsSession` (шире, чем
  `SessionService.VsUser`/`VsSession` — нужны `Modules`/`Name`/
  `AllowWithoutToken`/`SelfOnly` для `/me`), `CustomRole`/`PendingUser`/
  `LoginRecord`/`SamokatLoginResult`, все константы ролей/модулей/действий
  скопированы 1-в-1 из `vs-auth-pg.js`.
- `Services/AuthService.cs` — полный порт роли/пользователи/сессии/заявки/
  логи + `HashPassword`/`VerifyPassword` (scrypt) + `SamokatLoginAsync`
  (тот же URL/заголовки/тело, что `samokatLogin`). **Намеренно НЕ
  переиспользует `SessionService.cs`** (Фаза 1, уже используется другими
  доменами для гейтинга) — у него урезанный `VsSession` без `Modules`/
  `Name`/`AllowWithoutToken`/`SelfOnly` и без «скользящего» touch TTL.
  `AuthService` держит свою полную `GetSessionAsync`/`CreateSessionAsync`,
  1-в-1 портируя `vs-auth-pg.js`, чтобы не трогать уже проверенный код
  других доменов — сознательный выбор из плана, не забытая дедупликация.
- `Endpoints/AuthEndpoints.cs` + `VsAdminRequiredFilter.cs` (новый, по
  образцу `VsSessionRequiredFilter.cs` — читает `VsSession` из
  `HttpContext.Items`, требует роль `admin`/`developer`, иначе 403).
  4-ветвистая логика `/api/vs/auth/login` перенесена дословно (сайт-пароль
  [+опционально WMS-токен тем же паролем] / `allowWithoutToken` без пароля
  / WMS-пароль как единственная проверка). `PUT /api/vs/admin/users`
  специально принимает тело как `JsonElement`, а не типизированный POCO —
  нужно различать «поле не прислали» (не трогать) от «поле прислали как
  null/false» (обнулить), как в оригинальном `payload.x !== undefined`;
  обычная POCO-десериализация не смогла бы отличить эти случаи для `bool`.
- Куки `vs_sid`: `httpOnly`, `path=/`, `maxAge=30d`, `sameSite=lax` — те же
  атрибуты, что и в Node.
- `/api/vs/telegram/*` и Telegram-consumer-loop НЕ перенесены (см. выше).

### Найденный и исправленный баг: JSONB-параметры в сыром Npgsql

Первый живой прогон логина сразу упал: `column "modules" is of type jsonb
but expression is of type text`. В отличие от `pg` (Node), который неявно
кастует JS-объект в `jsonb` на клиенте, «сырой» `Npgsql` (без EF Core)
требует явного `::jsonb`-каста в SQL-тексте параметра — этого нет ни у
кого в проекте до сих пор (`SessionService.cs` только читает JSONB, никогда
не пишет через raw ADO.NET). Исправлено добавлением `::jsonb` к каждому
JSONB-плейсхолдеру в `INSERT`/`ON CONFLICT DO UPDATE` (`vs_custom_roles.
modules`, `vs_users.{modules,actions,company_ids,visible_companies}`,
`vs_sessions.{company_ids,modules}`). Нашлось только реальным прогоном —
`dotnet build` эту ошибку не ловит (она рантайм-only, тип параметра
разрешается при выполнении запроса).

### Caddy — маршрутизация

`/api/vs/auth/*`, `/api/vs/admin/roles*`, `/api/vs/admin/pending*`,
`/api/vs/admin/users*` → `dotnet:5080`. `/api/vs/telegram/*` без блока —
падает в общий `handle{node}`, как и `/api/node/*`.

### Верификация (реальный Docker, `docker compose build`+`up`)

1. **`dotnet build`** — чисто с первого раза (кроме ожидаемых предупреждений
   NU1701/NU1902/NU1903), никаких новых ValueTuple-подобных сюрпризов в
   этой фазе.
2. **Живой сквозной прогон через `curl`** (после перезапуска `node` и
   `caddy`, чтобы подхватить правки — `docker compose up -d` пересоздаёт
   только изменившиеся образы, `caddy`/`node` держат конфиг/код в памяти
   до рестарта):
   - `POST /api/vs/auth/register` → `GET /api/vs/admin/pending` (админ)
     показывает заявку, `sitePasswordHash` — реальный scrypt-хэш из C#.
   - Логин НЕобновлённым пользователем ДО одобрения → `403` «заявка ещё не
     одобрена» (правильная ветка).
   - `POST /api/vs/admin/pending/approve` (роль `manager`) → пользователь
     появился в `vs_users`, заявка удалена из `vs_pending_users`.
   - **Логин по сайт-паролю** тем же паролем, что при регистрации → `200`,
     верные `role`/`modules` — это САМЫЙ важный тест: подтверждает
     scrypt-совместимость на реальном сквозном пути (Node никогда не видел
     этот пароль/хэш — от `HashPassword` до `VerifyPassword` всё целиком в
     C#), а не только в изолированном тесте из риск-раздела выше.
   - Логин пользователем с `allowWithoutToken=true, passwordHash=null` →
     `200`, сессия создана, кука выставлена.
   - **Логин пользователем без `allowWithoutToken`** (WMS-ветка) → реальный
     HTTP-запрос до `api.samokat.ru` УСПЕШНО дошёл (362 мс, не быстрый
     network-fail) и вернул легитимный ответ авторизации Samokat (неверные
     тестовые креды → `401 "Неверный пароль"`, ожидаемо) — подтверждает,
     что `SamokatLoginAsync` реально достижим и работает из этой песочницы,
     не пришлось помечать как непроверяемое.
   - `GET /api/vs/auth/me` с кукой → верные `name`/`role`/`modules`/
     `selfOnly`/`companyIds`.
   - `POST /api/vs/auth/logout` → кука очищена, повторный `/me` → `401`.
   - Роли (admin): `POST`/`GET`/`PUT`/`DELETE /api/vs/admin/roles` —
     полный CRUD кастомной роли подтверждён.
   - Пользователи (admin): `GET`/`PUT`/`DELETE /api/vs/admin/users` —
     обновление полей и удаление подтверждены.
   - **Гейтинг ролью подтверждён**: сессия с ролью `manager` получает `403`
     на `/api/vs/admin/roles` (не `admin`/`developer`).
   - Один пограничный случай, воспроизводящий поведение ОРИГИНАЛА, а не
     баг переноса: тестовый пользователь, вставленный вручную с
     неканоническим логином (`9990001122` без `+7`, в обход обычного
     `saveUser`/`approvePendingUser`, которые всегда канонизируют), даёт
     дублирующуюся синтетическую запись `hasAccess:false` в `GET /api/vs/
     admin/users` — это точное поведение оригинального `getAllUsersForAdmin`
     (Map-ключ по «сырому» `u.login`, а не по нормализованному ключу лога),
     не новый баг порта.
   - `migrate-vs-auth-files-to-pg.js` прогнан на реальном контейнере —
     идемпотентно создал схему, корректно отработал «не найден —
     пропускаем» для всех 4 файлов (в этом чекауте нет legacy
     `vs-*.json` — свежая песочница).
   - Тестовые пользователи/сессии/попытки логина удалены из Postgres после
     прогона — песочница чистая.

**Не сделано**: формальный фикстур-тест для `buildSummaryFromItems`-класса
сверки здесь не применим (нет такой функции в этой фазе); не проверялся
явно случай одновременного редактирования одного пользователя двумя
параллельными запросами (узкое окно гонки в `saveUser`, описанное и
осознанно принятое ещё в шапке `vs-auth-pg.js`).

## Развёртывание — Docker теперь собирает редизайн `new zlp`, не оригинал (2026-07-15)

Пользователь развернул стек публично (внешняя панель управления по
`NODE_TOKEN`/`NODE_NAME` из `.env`, порт наружу через `PORT`) и хотел
открыть его в браузере — обнаружилось, что `Dockerfile` всё ещё собирал
**оригинальный** `frontend/app` (скопирован в этот сиблинг-проект вместе с
`backend/`/`tools/` при создании песочницы), а не редизайн `new zlp`, где
прошли Треки 1-3. Реального разделения на «тестовый бэкенд» и «нода для
внешней панели» нет — это один и тот же docker-compose стек, значит и
собирать нужно то, что реально хотят показывать.

- **`.env`**: `PORT` 3007 → 3009, `NODE_TOKEN`/`NODE_NAME` — реальные
  значения пользователя (были плейсхолдерами `your_random_secret_here`/
  `Нода`). `PORT` — это хостовый порт Caddy (`${PORT:-3009}:3009` в
  `docker-compose.yml`), не порт самого Node внутри контейнера (тот всегда
  `3009`, жёстко переопределён в `environment:` — см. существующий
  комментарий там).
- **`docker-compose.yml`** — у сервиса `node` `build: .` заменено на
  `build: { context: ., additional_contexts: { newzlp: ../new zlp } }`.
  Сознательно НЕ расширяли весь build context на родительскую папку
  (`рабочий стол/`) — там же `zlp-main-main` и другие проекты, это было бы
  и медленнее, и шире, чем нужно. Именованный доп.контекст (Compose
  Specification, поддерживается Docker Compose v5.1.4/Engine 29.5.3 —
  версии в этом окружении) даёт доступ ровно к одной нужной сиблинг-папке.
- **`Dockerfile`**, stage `frontend-builder` — `COPY frontend/app/...` →
  `COPY --from=newzlp ...`. Остальное не изменилось: собранный `dist/`
  по-прежнему копируется в `./frontend/app/dist/` в финальном образе — путь
  жёстко зашит в `server.js` (`DIST_DIR = __dirname/../frontend/app/dist`),
  трогать не нужно было.
- **`new zlp/.dockerignore`** (новый, в самой `new zlp`, не в этом
  проекте) — там не было ни `.dockerignore`, ни `.gitignore` вообще;
  добавлен минимальный (`node_modules/`, `dist/`, `.git/`, `*.log`), иначе
  `COPY --from=newzlp . ./` протащил бы в билд-контекст уже установленный
  `node_modules` (другая ОС/архитектура — сборка в Alpine-контейнере) и
  собственный `dist/` от локальных прогонов `npm run build`.
- **Верификация**: `docker compose build node` — чисто, реально собрал
  `new zlp` (`vite build`, тот же вывод, что и локально). После
  `docker compose up -d --force-recreate node`: `GET /` на порту 3009
  отдаёт `<title>` редизайна, не оригинала; `GET /api/vs/auth/me` (401 без
  сессии, `Kestrel`/`Caddy` в заголовках) и `GET /api/node/status` (с
  реальным `NODE_TOKEN`, `{"ok":true,"name":"new zlp",...}`) по-прежнему
  работают через тот же порт — swap фронтенда не задел API.
- Отдельный dev-сервер `new zlp` (`npm run dev`, порт 5174) при этом тоже
  чинился в рамках этого же захода: после смены `PORT` 3007→3009 его
  vite-прокси (`vite.config.js`) смотрел в порт, который Caddy больше не
  слушает — обновлён дефолт на 3009.

## Найден и исправлен реальный баг — дубли внутри батча валили весь дуал-райт в Postgres (2026-07-15)

Пользователь нажал «Обновить данные» в разделе Статистика на живом стенде,
увидел тост об успехе, но статистика осталась пустой. Раскопки по логам
контейнеров (`docker compose logs dotnet`) нашли настоящую причину: реальный
браузерный фетч (`fetchDataViaBrowser`, есть WMS-токен) честно забрал ~14
часовых пачек за день и записал их в JSON (Node, `backend/data/2026-07-15/`)
— это отработало штатно. Но параллельный дуал-райт в Postgres
(`POST http://dotnet:5080/api/stats/ops/ingest`, см. «Фаза 3») почти
целиком провалился: `IngestOpsAsync`/`SavePlacementItemsAsync`/
`SaveReceivingItemsAsync`/`SaveRemainsItemsAsync` проверяли дубль ТОЛЬКО
запросом к уже сохранённым строкам в БД (`_db.WmsOps.AnyAsync(...)` /
`FirstOrDefaultAsync(...)`) — если два элемента с одинаковым
`(Date, Hour, MergeKey)` попадались **в одном и том же батче** (реальные
данные WMS: одна и та же операция иногда прилетает дважды на пересекающихся
страницах пагинации), оба проходили эту проверку (ни один ещё не
закоммичен), оба добавлялись в `SaveChangesAsync()` — и весь батч падал с
`23505: duplicate key value violates unique constraint
"wms_ops_date_hour_merge_key_key"`. Так как дуал-райт — fire-and-forget
(`server.js` не ждёт ответа `/ingest`, см. «Фаза 3»), Node всё равно
отвечал фронту успехом, а дотнет-таблицы (откуда `StatsPage.jsx` читает
сводку через `/api/date/*`) оставались пустыми для всех часов, кроме одного
(которому повезло не содержать дублей). Живой пример на проде: 137 строк
`wms_ops` за час=7 сохранились, а часы 00-06 и 09-14 (JSON-файлы реально
есть, по несколько МБ каждый) в Postgres не попали вообще.

- **Исправление** (`backend-dotnet/Services/StatsService.cs`, все 4
  домена — Ops/Placement/Receiving/Remains): добавлен локальный
  `Dictionary`/`HashSet` по ключу `(Date, Hour, MergeKey)`, который
  учитывает уже добавленные В ЭТОМ ЖЕ батче сущности — второй дубль внутри
  одного вызова теперь либо тихо пропускается (Ops — «первый выигрывает»),
  либо мёрджится в уже добавленную в этом батче сущность (Placement/
  Receiving/Remains — они и так «мёрдж, не первый выигрывает» семантика),
  вместо попытки повторной вставки с тем же уникальным ключом.
- **Побочно найдено, не баг**: ночная смена в `GetHoursToLoad` использует
  дату НАЧАЛА смены (21:00 текущей даты → 00:00-08:59 СЛЕДУЮЩЕЙ) — 1-в-1
  как в оригинальном `storage.js:getHoursToLoad`. Из-за этого данные раннего
  утра (например, час 7 сегодня) корректно ищутся под датой «вчера + ночь»,
  а не «сегодня + ночь» — свойство архитектуры, не регрессия.
- **Верификация**: `docker compose build dotnet` — чисто (только
  предсуществующие NuGet-warnings), `docker compose up -d --force-recreate
  dotnet` — контейнер healthy, `GET /api/dotnet-status` — 200. Прямой
  запрос `GET /api/date/2026-07-14/summary?shift=night` (та самая
  утренняя часть смены) подтвердил, что уже закоммиченные 137 строк
  читаются корректно (`totalOps: 137`, реальные исполнители/время). Уже
  потерянные из-за бага часы (00-06, 09-14) **не восстановлены
  backfill'ом** — их сырые items в Node лежат уже в смёрженном/уплощённом
  виде (`backend/data/<date>/<hour>.json`), а не в исходной форме, которую
  ждёт `IngestOpsAsync` (`raw.responsibleUser`/`raw.product`/…) — писать
  скрипт, реконструирующий сырую форму из уже смёрженных полей, рискованнее,
  чем попросить пользователя просто нажать «Обновить данные» ещё раз: WMS
  отдаст те же операции заново, а фикс теперь корректно доведёт их до
  Postgres.

## Дуал-райт в Postgres был fire-and-forget — гонка с чтением статистики (2026-07-15)

Тот же пользователь после дедуп-фикса выше сообщил ещё один симптом:
последний `save-fetched-data` долго обрабатывался, и данные в статистике
появились только после ручной перезагрузки страницы. Причина — во всех 4
эндпоинтах `backend/server.js` (`/api/save-fetched-data`, `/api/stats/
{placement,receiving,remains}/save`) дуал-райт в dotnet (`fetch('http://
dotnet:5080/api/stats/*/ingest', ...)`) был запущен БЕЗ `await` — только
`.catch(err => console.error(...))`, fire-and-forget. Node отвечал клиенту
успехом сразу после сохранения JSON-файлов (и — для ops — после
синхронного вызова .NET-инструмента `SaveFetchedData` на слияние по часам),
не дожидаясь реального завершения записи в Postgres. Раз `new zlp`'s
`StatsPage.jsx` сразу после успеха «Обновить данные» дёргает `GET /api/date/
*/summary` (полностью на dotnet/Postgres, см. Фаза 3), получалась честная
гонка: сводка перечитывалась раньше, чем инжест успевал закоммитить
строки — пользователь видел пустую/неполную статистику, пока фоновый
инжест не дожимал в фоне (следующая перезагрузка страницы это уже
заставала).

- **Исправление** (`backend/server.js`, все 4 эндпоинта): `fetch(.../ingest)`
  теперь `await`-ится ПЕРЕД отправкой ответа клиенту. Ошибка инжеста
  по-прежнему НЕ валит основной ответ (JSON-файлы остаются source of truth
  для Node-side CLI-тулов — `ArticleSpeeds`/`WeightScan`/
  `MissingWeightRebuild`/`EmployeePerformance`), но теперь попадает в новое
  поле ответа `dotnetError` — оно уже ожидалось на фронте (`new zlp`'s
  `wmsFetch.js`, `fetchDataViaBrowser` читает `saveRes.dotnetError` для ops
  с самого начала Трека 3), просто бэкенд никогда его не заполнял.
- **Верификация**: `node --check backend/server.js` — синтаксис ок;
  `docker compose build node` + `up -d --force-recreate node` — контейнер
  healthy, `GET /` — 200. Полный положительный цикл (реальный медленный
  фетч → корректный await → сводка сразу отражает новые данные без
  перезагрузки страницы) не проверен вживую в этом окружении — нет
  реального WMS-аккаунта для повторного запуска фетча; логика изменения
  прямолинейна (просто `await` вместо fire-and-forget) и по стеку вызовов
  не меняет ничего, кроме момента ответа.

## Найден и исправлен N+1 — awaited-инжест выше сделал медленный запрос видимым (2026-07-15, тот же день)

Сразу после фикса выше пользователь пожаловался, что `save-fetched-data`
теперь висит больше 3 минут. Причина — awaited-инжест не создал проблему, а
ОБНАЖИЛ уже существующую: `IngestOpsAsync`/`SavePlacementItemsAsync`/
`SaveReceivingItemsAsync`/`SaveRemainsItemsAsync` проверяли дубль (см.
предыдущий фикс) одним `SELECT EXISTS`/`FirstOrDefaultAsync` НА КАЖДЫЙ
элемент батча — классический N+1. Живые логи dotnet за 10 минут показали
**40 215** таких запросов, отдельные вызовы `/api/stats/ops/ingest`
занимали 3.6–7.2с КАЖДЫЙ. Пока дуал-райт был fire-and-forget (до
предыдущего фикса), эта медлительность была не видна пользователю — Node
отвечал сразу, не дожидаясь. После того как ответ стал ждать реального
завершения инжеста (правильно, см. выше), эта же медлительность стала
временем ожидания пользователя — умноженная на ~12 часовых пачек
(day-смена) сессии подряд, вот и «больше 3 минут».

- **Исправление** (все 4 метода в `StatsService.cs`): переход с N запросов
  на батч к **1 запросу на уникальную пару (Date,Hour)** — почти всегда
  ОДНА пара на вызов (весь батч — это одна часовая пачка от `wmsFetch.js`).
  Двухпроходная схема: сначала лёгким проходом по `rawItems` (без похода в
  БД) собираются все уникальные (Date,Hour), затем одним запросом на пару
  подтягиваются уже существующие строки/ключи в `Dictionary`/`HashSet`,
  и только потом основной проход по элементам батча работает уже с
  предзагруженным индексом в памяти вместо запроса в БД на каждый элемент.
  Для Ops (только "первый выигрывает", без мёрджа полей) это `HashSet<string>`
  на пару, засеянный уже существующими `merge_key` — `HashSet.Add(...)`
  возвращающий `false` элегантно покрывает и "уже в БД", и "дубль внутри
  этого же батча" одним и тем же вызовом. Для Placement/Receiving/Remains
  (мёрдж полей в существующую строку) — `Dictionary` с уже
  ЗАГРУЖЕННЫМИ (tracked) сущностями, чтобы обновления полей на найденной
  строке попали в `SaveChangesAsync()`.
- **Верификация**: `docker compose build dotnet` — чисто, `docker compose up
  -d --force-recreate dotnet` — healthy, `GET /api/dotnet-status` — 200.
  Пересоздание контейнера прервало уже висевший (>3 мин) запрос
  пользователя — по факту нужно нажать «Обновить данные» ещё раз, теперь
  должно отработать на порядки быстрее (1 запрос на пару вместо тысяч
  запросов на элемент). Живая скорость на реальном большом батче не
  измерена постфактум (нет доступа повторить тот же WMS-фетч без участия
  пользователя).

## Убрать JS-дублирование в дуал-райт мосте — placement/receiving/remains (2026-07-15)

По итогам разбора «что где считается» (см. `new zlp/PLAN.md`) выяснилось:
`backend/storage.js` (1490 строк) — весь ещё не убранный кусок JS-бизнес-
логики, ровно то, что запрещает главный принцип проекта. Часть уже мертва
трафик-wise (`getDateSummary`/`getPlacementSummary`/`getReceivingSummary`/
`getRemainsSummary` — Caddy давно увёл `/api/date/*` на dotnet, Фаза 3), но
**запись** — `savePlacementItems`/`saveReceivingItems`/`saveRemainsItems` —
до сих пор считалась в Node на каждый реальный фетч, ПАРАЛЛЕЛЬНО с той же
самой логикой, только что переписанной на C# для дуал-райта в Postgres
(`StatsService.cs`, см. фикс выше) — то есть один и тот же мёрдж считался
дважды, в двух рантаймах, независимо. По решению пользователя (сузили
масштаб — фронтенд-расчёты ShiftPlanPage/HourlyReport/AnalysisPage
сознательно не трогаем в этом заходе) устранили именно этот дубль.

Домен `ops` (`/api/save-fetched-data`) этой проблемы уже не имел — Node там
ничего сам не считает, а пересылает JSON готовому .NET CLI-инструменту
`tools/SaveFetchedData` (`execFileAsync`, временный файл на вход, JSON на
stdout). Ровно этот же паттерн повторён для трёх оставшихся доменов.

- [x] **`tools/SavePlacementData`**, **`tools/SaveReceivingData`**,
      **`tools/SaveRemainsData`** — три новых сиблинг-инструмента (структура
      1-в-1 с `SaveFetchedData`: `--input`/`--data-dir`, толерантный разбор
      3 форм входа, атомарная запись tmp+rename), каждый со своей merge-
      семантикой, перенесённой ИЗ `storage.js` дословно, поле в поле:
      - **Placement**: первичный таймстамп `createdAt??completedAt??updatedAt`,
        merge-key `id||handlingUnitBarcode||createdAt|executorId|targetCellAddress`,
        фоллбэк при коллизии — `executorId`/`executor` (если у нового пусто),
        `targetCellsAddresses` (если у нового пустой массив),
        `skuCount` (если у нового 0). Остальные поля берутся из НОВОГО
        элемента безусловно (как `{...prev, ...item}` в JS) — в т.ч. если
        новый элемент прислал пустую строку в поле, которого нет в списке
        фоллбэков, старое значение честно затирается пустым — это
        воспроизведённая особенность оригинала, не баг порта (проверено
        smoke-тестом, см. ниже).
      - **Receiving**: первичный таймстамп `completedAt??createdAt??updatedAt`
        (обратный приоритет относительно Placement/Remains), `responsibleUser`
        может прийти как `acceptedBy`, merge-key `id||completedAt|executorId|taskNumber`,
        фоллбэк — `eoCount` (числовой), `executorId`/`executor`.
      - **Remains**: первичный таймстамп как у Placement, merge-key
        `id||createdAt|executorId|sourceHU|targetHU`, фоллбэк —
        `executorId`/`executor`, `consolidationItems` (произвольный массив,
        сохранён как `JsonArray`/opaque pass-through, не разбирается —
        как и в JS, только сравнивается длина).
      - Опаковые массивы (`targetCellsAddresses`/`consolidationItems`)
        реализованы через `System.Text.Json.Nodes.JsonArray`, а не голый
        `JsonElement` — избегает проблемы с `JsonDocument.Dispose()`
        (`JsonElement`, полученный из одного документа, невалиден после
        чтения ДРУГОГО файла в том же процессе; `JsonArray` — независимая,
        не привязанная к документу структура).
      - Мёрдж-при-коллизии реализован через record `with`-выражение
        (`item with { <фоллбэк-поля> }`) — начинает с нового элемента
        (эквивалент `{...prev, ...item}`, раз item задаёт все поля) и
        переопределяет только те поля, что реально фоллбэчатся на `prev`, —
        то же самое, короче и без риска пропустить поле.
- [x] **`Dockerfile`** — `dotnet-builder`: +3 строки `dotnet publish` в
      существующую `&&`-цепочку (список явный, НЕ по глобу — подтверждено);
      `runner`: +3 строки `COPY --from=dotnet-builder`.
- [x] **`backend/server.js`** — добавлены `getDotnetSavePlacementCmd()`/
      `getDotnetSaveReceivingCmd()`/`getDotnetSaveRemainsCmd()` (тот же
      2-путевой резолв DLL→csproj-fallback→null, что и у
      `getDotnetSaveFetchedCmd()`). Три эндпоинта `/api/stats/{placement,
      receiving,remains}/save` переписаны по образцу `/api/save-fetched-
      data`: пишут `items` во временный файл (`DATA_DIR/raw_tmp/<domain>_
      <ts>.json`), `execFileAsync` соответствующий инструмент, парсят
      `{ok,added,skipped,byShift}` со stdout, удаляют временный файл в
      `finally`. Прямой вызов `storage.save*Items(items)` убран. Всё
      остальное — порядок `updateNamesRegistry` до записи, дуал-райт POST
      на `dotnet:5080/api/stats/*/ingest` после, форма ответа клиенту —
      БЕЗ ИЗМЕНЕНИЙ.
- **`storage.js` физически не тронут** — три write-функции (`savePlacementItems`/
  `saveReceivingItems`/`saveRemainsItems`) и их хелперы (`normalize*Item`/
  `load*Hour`/`*FilePath`/`*Dir`) теперь мёртвый код (никто их больше не
  вызывает), read-функции (`getPlacementSummary` и т.д.) были мертвы уже
  давно (Caddy). Сознательное решение — удаление мёртвого кода отложено
  отдельным заходом, чтобы не смешивать риски миграции логики с риском
  чистки.
- **Верификация**:
  - `docker compose build node` — чисто, все 8 `dotnet publish` (5
    существующих + 3 новых) прошли успешно.
  - Смоук-тест каждого нового инструмента напрямую (`docker compose exec
    node dotnet tools/<Name>/bin/Release/net9.0/<Name>.dll --input ...
    --data-dir /tmp/testdatadir`) на синтетическом JSON с дублирующимся
    merge-key и расходящимися полями — построчно сверен с ожидаемым
    результатом по семантике `storage.js`:
    - Placement: `skuCount`/`targetCellsAddresses` корректно фоллбэчатся на
      предыдущее значение, когда у нового элемента 0/пустой массив; прочие
      поля (включая `status`) берутся из нового элемента безусловно.
    - Receiving: `eoCount` фоллбэчится численно; поля без фоллбэка (`type`,
      `supplierName`), отсутствующие во втором элементе, корректно
      затираются пустой строкой — воспроизведена особенность оригинала.
    - Remains: `consolidationItems` фоллбэчится на предыдущий непустой
      массив, когда у нового элемента пустой.
  - `docker compose up -d node` (обычный `up`, не force-recreate — образ
    просто обновлён) — `GET /` — 200, контейнер healthy.
  - **Не проверено вживую**: полный цикл через реальный WMS-фетч (нет
    аккаунта в этой среде) — стоит попросить пользователя нажать «Обновить
    данные»/«Перепроверить» ещё раз и подтвердить, что `backend/data/<date>/
    {placement,receiving,remains}/<HH>.json` по-прежнему обновляются (теперь
    через новые инструменты) и дуал-райт в Postgres не деградировал.

## Найдена реальная причина «снова долго» — фиксированный старт .NET-процесса × кол-во часов (2026-07-15, тот же день)

Диагностика (прямой `curl` на `/api/save-fetched-data` с синтетическими
батчами, `docker compose exec`) показала: `timings.dotnetMs` (запуск
`dotnet SaveFetchedData.dll` через `execFileAsync`) — это **фиксированные
~450-500мс на старт процесса**, почти не зависящие от объёма данных (на
батче в 50 элементов это ~90% всего времени запроса; на батче в 8000
элементов — уже относительно небольшая доля от 3.5с). Причина медленного
`save-fetched-data` была не на бэкенде (здесь уже всё быстро — и N+1-фикс,
и awaited-инжест), а во фронтенде: `new zlp`'s `wmsFetch.js` слал
**отдельный** POST на каждый час вместо одного запроса на весь фетч,
умножая эти фиксированные ~500мс на количество часов в смене (до ~12 для
дневной смены). Подробности и фикс (убран цикл по часам в
`fetchDataViaBrowser`, теперь один запрос) — в `new zlp/PLAN.md`. Здесь
никакие файлы не менялись — `SaveFetchedData.dll` уже и раньше корректно
обрабатывал многочасовые батчи одним вызовом (подтверждено этим же
диагностическим `curl`-тестом на синтетических 8000 элементах/3 часах).

## Побочный регресс от предыдущего фикса — инжест в Postgres упирался в лимит тела запроса (2026-07-15, тот же день)

Сразу после фикса выше пользователь сообщил: статистика перестала
обновляться после `save-fetched-data`. Логи `node` показали:
`save-fetched-data: dotnet ingest failed: dotnet ingest HTTP 413`.

Причина — прямое следствие фикса «один запрос вместо одного на час»
(`new zlp/PLAN.md`): раньше каждый файл-мёрдж-вызов `/api/save-fetched-
data` попутно слал в Postgres (`dotnet:5080/api/stats/ops/ingest`) только
items ОДНОГО часа — небольшой запрос. После того как фронтенд стал слать
все часы одним вызовом на файловый мёрдж, ТОТ ЖЕ полный список items
целиком (без деления) уходил и в этот отдельный HTTP-вызов на Postgres-
инжест — а в `backend-dotnet/Program.cs` уже был явно выставлен
`Kestrel.Limits.MaxRequestBodySize = 50 * 1024 * 1024` (50 МБ, изначально
под фото-аплоады). Полный дневной объём операций легко превышает этот
лимит (реально замерено: 23 МБ проходит, 60 МБ — `413`). Из-за этого
Postgres-инжест целиком проваливался за один раз (JSON-файлы при этом
сохранялись успешно — `SaveFetchedData.dll` не имеет отношения к этому
лимиту, он получает данные через временный файл, не HTTP), а раз
`StatsPage.jsx` читает сводку ИСКЛЮЧИТЕЛЬНО из Postgres — статистика не
обновлялась, хотя сам фетч отчитывался об успехе.

- **Исправление** (`backend/server.js`): добавлен общий хелпер
  `ingestInChunks(url, items)` — режет `items` на куски по
  `ITEMS_INGEST_CHUNK_SIZE = 10000` и шлёт их в dotnet-инжест
  ПОСЛЕДОВАТЕЛЬНО, по одному куску за раз (await в цикле, не Promise.all —
  дедуп в `IngestOpsAsync`/`Save*ItemsAsync` каждый раз сверяется с уже
  закоммиченными строками, в т.ч. из предыдущих кусков ЭТОГО же запроса,
  так что порядок и последовательность важны, гонки внутри одного запроса
  быть не должно). Применён ко всем 4 доменам (ops/placement/receiving/
  remains) — placement/remains пока не сталкивались с этим на практике
  (их объёмы меньше), но защищены на будущее той же логикой, без
  дублирования кода. Дорогая часть (запуск `dotnet SaveFetchedData.dll`)
  как и раньше — один раз на весь батч, фикс НЕ возвращает деление по
  часам, режется только сам HTTP-вызов в Postgres.
- Лимит Kestrel (50 МБ) не менялся — с чанками по 10 000 элементов
  отдельный запрос почти никогда не приблизится к этому потолку независимо
  от объёма реального фетча.
- **Верификация**: `docker compose build node` — чисто, `docker compose up
  -d --force-recreate node` — healthy. Восстановлен ТОЧНО тот же сценарий,
  что уронил инжест (130 000 синтетических элементов, ~62 МБ, реальный
  `POST /api/save-fetched-data` через сам эндпоинт, не в обход) — теперь
  `dotnetError: null`, `added: 130000`, `skipped: 0`. Синтетические тестовые
  строки полностью вычищены после теста: из Postgres (`DELETE FROM wms_ops
  WHERE item_id LIKE 'chunktest-%'` и отдельно `item_id ~ '^x[0-9]+$'` —
  остаток от более раннего прямого теста на `dotnet:5080` в обход Node) и
  из JSON-файлов (`backend/data/2026-07-15/{11,12,13,14,15}.json` —
  синтетические записи заэмигрировали в московские часы, отличные от UTC-
  часов, которые я задавал в тестовых данных, задели реальные данные этих
  же часов; вычищены точечно, реальные записи в тех же файлах не
  тронуты — проверено `count` до/после фильтрации).

## S3/RustFS — реальные креды вместо заглушек (2026-07-15)

`.env` с самого создания `new zlp-backend` содержал заглушки
(`S3_ENDPOINT=http://YOUR_MEDIA_SERVER_IP:9000`, `your_access_key`,
`your_secret_key`) — их никогда не заменяли на реальные. Загрузка фото
(`POST /api/rk/photos` → `S3Service.cs` → `PutObjectAsync`) поэтому не
могла работать в принципе (пыталась подключиться к несуществующему хосту).
Пользователь предоставил реальные креды своего RustFS.

- [x] `.env` — `S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_PUBLIC_URL`
      заменены на реальные значения (бакет `zlp-media` не менялся).
- [x] `docker compose up -d --force-recreate dotnet` — подхватить новые
      переменные окружения (читаются один раз при старте `S3Service`).
- **Верификация — полный сквозной тест через реальный эндпоинт** (не
  напрямую в RustFS, а через приложение): `curl -F photos=@test.jpg
  http://localhost:3009/api/rk/photos` → `200, {"ok":true,"urls":[...]}`;
  `GET /rk-photos/<file>` → `301` редирект на реальный
  `http://77.91.94.203:9000/zlp-media/rk-photos/<file>` → `200` — фото
  реально долетает до RustFS и реально скачивается обратно. Тестовый файл
  (287 байт, `1x1` JPEG) остался в реальном бакете `zlp-media` — не
  удалён (для удаления через S3 API нужна подпись AWS SigV4, не стал
  форсировать через голый curl; можно убрать вручную через консоль/mc,
  если нужно — файл безобиден, но лежит в реальном бакете).

### `node`-контейнер не был пересоздан после фикса выше — фото в консолидации падали с `EAI_AGAIN your_media_server_ip` (готово, 2026-07-15)

Пользователь сообщил новую ошибку при загрузке фото в консолидации:
`getaddrinfo EAI_AGAIN your_media_server_ip`. Причина — фикс выше
пересоздал ТОЛЬКО `dotnet` (`--force-recreate dotnet`), т.к. на тот
момент проверялись только RK-фото (`S3Service.cs`, dotnet). Но
консолидация грузит фото через **Node**-путь (`backend/s3.js` +
`s3Storage.uploadFile` в `server.js`, тот же код, что и в оригинале,
см. `zlp-main-main/backend/s3.js`/`server.js:2655`) — а `node`-контейнер
с обновлённым `.env` так и не перезапускался, продолжал работать со
старыми заглушками, зафиксированными в его окружении при последнем
старте (`env_file` читается только при создании контейнера, не на лету).
Подтверждено напрямую: `docker compose exec node printenv | grep S3_`
показывал `S3_ENDPOINT=http://YOUR_MEDIA_SERVER_IP:9000` и
`S3_ACCESS_KEY=your_access_key` — старые заглушки, хотя `.env` на диске
уже содержал реальные значения.

- [x] `docker compose up -d --force-recreate node` — контейнер поднят
      заново, теперь `printenv` подтверждает реальные
      `S3_ENDPOINT=http://77.91.94.203:9000` и т.д.
- **Верификация — полный сквозной тест через реальный эндпоинт**:
  сгенерирован валидный тестовый JPEG (через `sharp` внутри самого
  контейнера — синтетический JPEG-заголовок из чистого текста не
  проходит валидацию `sharp`/libvips), `curl -F cell=TESTCELL -F
  barcode=1234567890 -F employeeName=... -F photo=@test.jpg
  http://localhost:3009/api/consolidation/complaints` → `200,
  {"ok":true,"id":"..."}`; `GET
  /api/consolidation/uploads/<id>.jpg` → `301` редирект на реальный
  `http://77.91.94.203:9000/zlp-media/consolidation/<id>.jpg` — фото
  реально долетает до RustFS через Node-путь. Тестовая запись удалена
  через реальный `DELETE /api/consolidation/complaints/:id` (не прямой
  правкой JSON-файла на диске — сервер держит `_complaintsCache` в
  памяти, правка файла напрямую разошлась бы с кэшем до следующего
  рестарта). Тестовый JPEG-файл в бакете `zlp-media/consolidation/`
  остался (та же причина, что и с RK-фото выше — удаление через голый
  curl потребовало бы подписи AWS SigV4).
- **Вывод на будущее**: при следующей правке `.env`, если она относится
  к переменным, которые читают ОБА сервиса (`S3_*`, `PG_*` и т.п.) —
  пересоздавать `node` И `dotnet` вместе, не только тот, что тестировался
  первым.

## Выдача ТСД — сотрудники без executorId, отдельный список (2026-07-15)

Пользователь: список сотрудников для выдачи ТСД брался ИСКЛЮЧИТЕЛЬНО из
основной таблицы `employees` (PK = `executor_id`, обязателен и в оригинале,
и в этом порте — `EmployeeService.cs`/`empl-pg.js` требуют его для
сохранения). Но в статистику WMS попадают не все реальные сотрудники
(человек мог не иметь смен ещё, или его WMS-активность просто не
зафиксировалась) — таких физически нельзя завести в общий реестр, а
значит нельзя выдать им ТСД через существующий раздел. Пользователь явно
подчеркнул: это должен быть ВТОРОЙ, независимый список, редактируемый
руками в Настройках (ФИО + компания, без executorId), и он должен
использоваться ИСКЛЮЧИТЕЛЬНО разделом «Выдача ТСД» — не должен попадать
ни в статистику, ни в мониторинг, ни в общий реестр Настроек →
Сотрудники.

**Архитектурное решение**: отдельная таблица `tsd_manual_employees` (PK —
синтетический `id` вида `manual-<12 hex>`, никогда не пересекается с
настоящими WMS UUID), никак не связанная с `employees` (в `tsd_assignments`
и так нет FK на `employees` — денормализованные строки `executor_id/
fio/company`, проверено чтением `AppDbContext.cs` перед началом работы —
значит синтетический id прекрасно проходит через весь существующий поток
назначения/возврата ТСД и QR-кодирования (`EMP:<executorId>`) без единой
правки в этой логике).

Схема (как и все остальные таблицы в проекте, включая уже полностью
перенесённые на dotnet домены) создаётся на старте **Node**, а не EF —
таков сквозной паттерн этого проекта (см. комментарий в
`AppDbContext.cs`: «EF только читает/пишет по уже готовой схеме»); сам
CRUD целиком на dotnet, т.к. TSD (`/api/tsd-assignments*`,
`/api/tsd-settings*`) и employees (`/api/employees`) уже там.

- [x] `backend/tsd-pg.js` — `init()` дополнен `CREATE TABLE IF NOT EXISTS
      tsd_manual_employees (id TEXT PRIMARY KEY, fio TEXT NOT NULL, company
      TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT
      now())` — рядом с `tsd_assignments`/`tsd_settings`.
- [x] `backend-dotnet/Models/TsdModels.cs` — `TsdManualEmployeeEntity`/
      `TsdManualEmployee`/`TsdManualEmployeeRequest`.
- [x] `backend-dotnet/Data/AppDbContext.cs` — `DbSet<TsdManualEmployeeEntity>`
      + маппинг на `tsd_manual_employees`.
- [x] `backend-dotnet/Services/TsdService.cs` — `ListManualEmployeesAsync`/
      `AddManualEmployeeAsync` (генерирует `id = "manual-" +
      Guid.NewGuid()...`) / `UpdateManualEmployeeAsync` /
      `DeleteManualEmployeeAsync`.
- [x] `backend-dotnet/Endpoints/TsdEndpoints.cs` — 4 новых маршрута под
      `VsSessionRequiredFilter` (как и все остальные TSD-эндпоинты):
      `GET/POST /api/tsd/manual-employees`,
      `PUT/DELETE /api/tsd/manual-employees/{id}`.
- [x] `Caddyfile` — новый блок `handle /api/tsd/manual-employees* {
      reverse_proxy dotnet:5080 }`, рядом с `/api/tsd-assignments*`/
      `/api/tsd-settings*`.
- [x] `src/lib/api.js` (`new zlp`) — `getTsdManualEmployees`/
      `addTsdManualEmployee`/`updateTsdManualEmployee`/
      `deleteTsdManualEmployee`.
- [x] `src/pages/settings/TsdSettingsCard.jsx` (`new zlp`) — новый
      экспортируемый компонент `TsdManualEmployeesCard`: таблица ФИО/
      Компания с инлайн-редактированием (сохранение по blur), формой
      добавления и удалением по кнопке. Подключен в `SettingsPage.jsx`
      рядом с `TsdSettingsCard`.
- [x] `src/pages/tsd/TsdIssuePage.jsx` (`new zlp`) — `load()` теперь тянет
      ТРИ источника параллельно (`api.getEmployees()` + новый
      `api.getTsdManualEmployees()` + `api.getTsdAssignments()`), второй
      источник мапится в ту же форму `{executorId, fio, company}` (где
      `executorId` — синтетический id) и конкатенируется с обычным
      реестром в один `employees` — вся остальная логика страницы
      (печать QR, назначение/возврат, статусы, сортировка/фильтры) не
      тронута, работает одинаково для обоих источников. Ошибка загрузки
      второго источника не валит страницу (`.catch(() => ({employees:
      []}))` — деградация до обычного реестра).
- **Верификация — полный сквозной тест через реальные эндпоинты** (после
  `docker compose build node dotnet` + `up -d --force-recreate node
  dotnet`; заодно обнаружилось и исправлено, что `Caddyfile` требует
  `docker compose restart caddy` — простой `up -d --force-recreate` двух
  других сервисов конфиг Caddy не подхватывает сам по себе): для
  аутентифицированных TSD-эндпоинтов вручную вставлена синтетическая
  сессия в `vs_sessions` (`session_id='test-tsd-manual-session'`, роль
  `admin`) — реальных креды для логина в этой среде нет, тот же приём,
  что и раньше для тестовых данных. `GET` (пусто) → `POST` (добавление,
  включая кириллицу через `--data-binary @file`, т.к. `curl -d` с
  кириллицей напрямую в git-bash на Windows бьёт кодировку аргумента —
  не баг эндпоинта) → `GET` (оба видны) → `PUT` (обновление ФИО/компании)
  → `DELETE` (оба) → `GET` (снова пусто) — весь CRUD прошёл `200 OK` с
  ожидаемыми телами ответов. Синтетическая сессия и тестовые записи
  удалены после проверки. Реальную сборку/печать QR и сканирование в
  TsdIssuePage.jsx вживую не проверял — нет физического сканера ТСД в
  этой среде; проверена только серверная часть + факт, что фронтенд
  собирается (`npm run build` — чисто) и мержит источники по коду.

## Перенос реальных данных с основного проекта — Шаг 4 (сотрудники) выполнен (2026-07-15)

Возобновили отложенный ранее план переноса данных (см. запись про
объединение фронтенда/бэкенда и паузу «ладно, пока отложим» на переносе
данных). Пользователь положил в `migration-staging/empl.json` реальную
выгрузку реестра сотрудников с основного проекта (хост) — формат `{employees:
[{executorId, fio, company, phone, password}]}`, 1:1 совпадает с ответом
`GET /api/employees` этого же проекта (у оригинала тоже Postgres-бэкенд для
сотрудников, `empl-pg.js`, та же схема) — предположение из плана про
«может не быть executorId в CSV» не подтвердилось, в реальной выгрузке
executorId есть у всех 439 записей.

- [x] `backend/migrate-empl-json-to-pg.js` — новый одноразовый скрипт по
      образцу остальных `migrate-*-to-pg.js` (`ON CONFLICT (executor_id)
      DO UPDATE` — безопасный upsert, НЕ `TRUNCATE`, в отличие от
      `POST /api/employees`/`EmployeeService.SaveAllAsync`, который
      затирает таблицу целиком — именно поэтому для переноса нужен был
      отдельный скрипт, см. изначальный план). Читает
      `migration-staging/empl.json`, пропускает записи без
      `executorId`/`fio` (в реальных данных таких не оказалось — 0 из
      439), логирует count до/после.
- **Как запускали** (`docker exec` внутрь `/app/backend` контейнера
  `node`, не через bind-mount `/app/host-project/backend/` — там нет
  `node_modules`, `require('pg')` резолвится только из настоящего
  `/app/backend`, куда пакеты ставились при сборке образа): скопировали
  сам скрипт и `empl.json` внутрь контейнера через `docker cp` (временно,
  не через постоянный volume — `migration-staging/` в `.dockerignore`
  сознательно, чтобы реальные данные не попадали в образ), прогнали,
  затем удалили обе временные копии изнутри контейнера (`rm`) — сам файл
  `migration-staging/empl.json` на хосте остался как есть.
- **Верификация**: `SELECT count(*) FROM employees` — 0 → 439, без единой
  ошибки. Выборочно сверены записи (`- Ракеш`/2К, кириллица с ФИО из
  нескольких слов) и распределение по 14 компаниям (Штат 1-4, ЭСК,
  Мувинг, Градус, 2К, Атлас, Заморозка 2, НС 2-4, УТЗ + 27 без компании).
  Дополнительно проверено через реальный `GET /api/employees` (не только
  напрямую в Postgres) — `employees: 439, companies: 14`, совпадает.
- **Осталось по исходному плану** (см. `sharded-jumping-heron.md` /
  раздел выше «Перенос данных с основного проекта в new zlp-backend» —
  план от 2026-07-13, пункты помимо сотрудников): (1) статистика/операции
  (`backend/data/<date>/<HH>.json` → `migrate-storage-json-to-pg.js`,
  самый большой домен), (2) VS-пользователи/сессии, (3) VS-auth JSON
  поддомены (кастомные роли/заявки/логи входов/telegram), (5) маршруты РК
  и ТСД, (6) фото — ждём, пока пользователь положит соответствующие
  файлы в `migration-staging/` (уточнить точный формат по факту файла
  перед написанием скрипта для каждого следующего шага — не гадать
  вслепую, тот же принцип, что и с сотрудниками, где предположение о
  «нет executorId» не подтвердилось).

## Перенос реальных данных — Шаг 5 (маршруты РК + ТСД) выполнен через pg_dump (2026-07-15)

Схемы `routes`/`tsd_assignments`/`tsd_settings` у нас и на хосте совпадают
1:1 (сверено кодом `route-rk-pg.js`/`tsd-pg.js` в обоих проектах) —
поэтому вместо JS-скрипта-переносчика использован прямой `pg_dump
--data-only --table=routes --table=tsd_assignments --table=tsd_settings`
с хоста + `psql -f dump.sql` сюда (`employees` из дампа сознательно
исключён — уже перенесён отдельно).

- Перед импортом `tsd_assignments` пришлось `TRUNCATE` — там было 4
  собственных тестовых строки из этой же сессии (ручное тестирование
  выдачи/возврата ТСД через браузер, `tsd` вида `ABC-abc-1234`/
  `MP:f3f86f94-...` — явно не реальные штрихкоды), которые иначе
  конфликтовали бы по PK (`id`, `BIGSERIAL`) с реальными id из дампа.
  `routes`/`tsd_settings` были уже пустые — TRUNCATE не потребовался.
- Импорт (`COPY` формат, `pg_dump` без `--inserts`) сам восстановил
  `id`-последовательность `tsd_assignments` через `setval` — ручной
  сброс не понадобился.
- **Результат**: `routes` 0 → 10865, `tsd_assignments` 0 (после truncate)
  → 1796, `tsd_settings` 0 → 1 (`total_count = 120`, реальное число ТСД
  на устройствах). Выборочно сверены записи (реальные маршруты за
  2026-07-16, `driver`/`cfz_addresses` — валидный JSONB).
- Временный файл дампа внутри контейнера `postgres` (`docker cp` →
  `/tmp/zlp_data_dump.sql` → `psql -f` → `rm`) убран после импорта.

## Что нашлось при полном докопировании persist (кроме дат) — новые домены

При повторном `docker cp`/`tar --exclude` персистентного тома (без папок
статистики) обнаружились домены, не учтённые в изначальном 6-шаговом
плане — реальные данные, не файлы-заглушки:

- `vs-users.json` (100КБ), `data/vs-sessions.json` (127КБ),
  `data/vs-custom-roles.json`, `data/vs-pending-users.json`,
  `data/vs-logins.json` (28КБ) — под них уже есть готовые скрипты
  (`migrate-vs-json-to-pg.js`/`migrate-vs-auth-files-to-pg.js`), см.
  следующий шаг.
- `data/consolidation.json` (2.5МБ!) — реальные жалобы через
  ConsolidationFormPage/ConsolidationPage — скрипта переноса ещё нет,
  формат не смотрели.
- `data/rollcall.json` (перекличка/мониторинг), `data/missing_weight.json`
  (340КБ, недостачи по весу), `data/names_registry.json` (53КБ, реестр
  ФИО для статистики/мониторинга), `data/violations.json` (2 байта —
  фактически пусто) — форматы ещё не смотрели, скриптов нет.
- `data/route-rk.json` (15МБ) — есть ОДНОВРЕМЕННО с Postgres-таблицей
  `routes` (та же, что уже перенесена выше) — нужно сверить, не новее
  ли файл базы (не проверяли ещё), прежде чем считать его устаревшим.
- Пропущено сознательно: `config.json`, `data/auto-fetch-settings.json`,
  `data/company-day-cache/` (кэш, регенерируется),
  `data/raw_tmp/`, `data/product-weights.xlsx`, `data/Отчет по РК.xlsx`
  (сгенерированный отчёт, не исходные данные).

## Перенос реальных данных — VS-пользователи/сессии + VS-auth поддомены (2026-07-15)

Использованы уже существовавшие `migrate-vs-json-to-pg.js`/
`migrate-vs-auth-files-to-pg.js` — оба доработаны: пути к исходным файлам
теперь переопределяемы через env (`VS_USERS_PATH_OVERRIDE`,
`VS_SESSIONS_PATH_OVERRIDE`, `VS_CUSTOM_ROLES_PATH_OVERRIDE`,
`VS_PENDING_PATH_OVERRIDE`, `VS_LOGINS_PATH_OVERRIDE`,
`VS_TELEGRAM_BIND_PATH_OVERRIDE`, дефолт — прежнее поведение, без env
переменных ничего не меняется) — понадобилось, т.к. реальные файлы лежат
в `migration-staging/`, а не по стандартным путям persist-тома ЭТОГО
контейнера (перезаписывать сами symlink'и persist-тома этого контейнера
чужими данными с другого хоста — плохая идея, файлы читаются напрямую по
пути через `/app/host-project/migration-staging/...`, доступному этому
контейнеру через существующий bind-mount).

- **Как запускали**: скопировали доработанные скрипты в
  `/app/backend/` контейнера `node` (`docker cp`, т.к. эти файлы не
  замонтированы индивидуально в `docker-compose.yml`, в отличие от
  `server.js`/`vs-auth.js`/`vs-auth-pg.js`), прогнали с `docker compose
  exec -e VS_*_PATH_OVERRIDE=... node node /app/backend/migrate-*.js`,
  удалили временные копии скриптов из контейнера после. Сами
  доработанные скрипты остались в `backend/` на хосте (в образ попадут
  при следующей пересборке — предназначены и для будущих разовых
  переносов, не только этого).
- **Результат**:
  - `vs_users`: 1 (свой аккаунт, созданный в этой сессии для тестов) →
    213 (перед переносом сверили — `+79213185040`/«Шабиев Вусал
    Шахмалыевич»/admin не пострадал, апсертнулся сам собой).
  - `vs_sessions`: 9 → 292 (1 просроченная сессия пропущена по TTL).
  - `vs_custom_roles`: 0 → 9 (реальные кастомные роли — «Кладовщик»,
    «Офис», «Бригадир», «ТСД» и т.д.).
  - `vs_pending_users`: 0 → 5 (заявки на регистрацию).
  - `vs_logins`: 2 → 224 (история попыток входа).
  - `vs-telegram-bind.json` не найден в выгрузке — пропущено скриптом
    штатно (нет данных — нечего переносить).

## Перенос реальных данных — оставшиеся файловые домены (2026-07-16)

После полного докопирования persist-тома (Способ А, за вычетом дат
статистики) обнаружились домены сверх изначального плана — все файловые
(не Postgres), перенесены прямой подстановкой файла в
`backend/data/<file>` (через symlink на persist-том) + `docker compose
restart node`, чтобы сбросить in-memory кэш сервера, где он есть
(`_complaintsCache` для consolidation.json).

- **`consolidation.json`** (2984 реальных жалобы) — у нас был пустой
  `[]` (2 байта), просто положен на место. Проверено через реальный
  `GET /api/consolidation/complaints` — `count: 2984`.
- **`names_registry.json`/`missing_weight.json`** — важное отличие от
  остальных шагов: здесь у НАС в контейнере УЖЕ было реальное (не
  тестовое) накопленное содержимое (164 имени / 169 позиций — судя по
  всему из реальных WMS-фетчей в этой сессии), а не пусто и не заглушка
  — поэтому не перезаписывали данными с хоста, а СЛИЛИ оба списка
  (`{...source, ...our}` для реестра имён — при конфликте побеждает
  своя версия; дедуп по `article` для недостач по весу, объединение
  массивов). Результат: 767 имён, 1132 позиции недостач.
- **`rollcall.json`** — НЕ перенесён: в выгрузке с хоста `shiftKey:
  "2026-07-14_day"`, у нас в контейнере уже `"2026-07-15_day"` (новее) —
  оставили свою версию, перезапись более старыми данными была бы
  регрессом.
- **`route-rk.json`** (15МБ, 3238 маршрутов, файловый снимок 2026-03-21 —
  2026-04-25) — сверен с уже перенесённым Postgres-дампом `routes`
  (10865 записей, 2026-03-21 — 2026-07-16): выборочно все id из файла
  нашлись в базе — файл строго устарел и полностью перекрыт, перенос не
  нужен.
- **`rk-photos/`/`uploads/`** — пустые в выгрузке (0 файлов). Реальные
  фото РК хранятся в S3/RustFS на проде (см. фикс реальных S3-кредов
  выше), не в файлах persist-тома — если понадобится перенос самих
  фото, это отдельная задача через `migrate-to-s3.js`-подобный скрипт с
  доступом к ОРИГИНАЛЬНОМУ бакету, не через `docker cp`.
- **`empl.csv`** (5 строк) — устаревший легаси-список, сотрудники давно
  на Postgres (439 записей, перенесены отдельно) — не переносился.
- **`violations.json`** — пустой (`[]`), нечего переносить.
- Пропущено сознательно (не данные, а конфиг/кэш/отчёты):
  `config.json`, `auto-fetch-settings.json`, `company-day-cache/`,
  `raw_tmp/`, `product-weights.xlsx`, `Отчет по РК.xlsx`.

**Перенос реальных данных с основного проекта на этом можно считать
завершённым** — все домены из `DATA_MIGRATION_HOWTO.md` либо перенесены,
либо осознанно пропущены с объяснением почему.
