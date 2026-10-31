# Резервные копии

Скрипт `backup.sh` каждую ночь сохраняет в `/opt/sber-wms/backups`:

| Файл | Что внутри |
|---|---|
| `db_<дата>.dump` | база PostgreSQL (сжатая выгрузка `pg_dump`) |
| `files_<дата>.tar.gz` | фото консолидации, видео нарушений, `config.json` |
| `rk_<дата>.tar` | фото приёмки и отгрузки (РК) |
| `env_<дата>` | `.env` — пароль базы и другие секреты |

Хранятся 7 дней (`KEEP_DAYS`). Если свободно меньше 8 ГБ (`MIN_FREE_GB`), копия не делается — чтобы не забить диск.

## Установка (один раз)

```bash
cd /opt/sber-wms
chmod +x backup/backup.sh
./backup/backup.sh                 # первый запуск вручную — проверить, что всё работает
crontab -e                         # и добавить строку:
30 3 * * * /opt/sber-wms/backup/backup.sh >> /opt/sber-wms/backups/backup.log 2>&1
```

Копия запускается в 03:30 — ночью, когда на сайте меньше всего людей.

## Копия за пределами сервера (по желанию)

Копия только на этом же сервере не спасёт при поломке диска. Чтобы копия уходила ещё и наружу (например, на Яндекс Диск):

1. Поставить `rclone` и настроить хранилище: `rclone config` (для Яндекс Диска — тип `yandex`).
2. Создать `backup/backup.env`:
   ```sh
   RCLONE_REMOTE=yadisk:sber-wms-backups
   REMOTE_KEEP_DAYS=14
   ```

## Восстановление

**База** (сайт на время восстановления лучше остановить: `docker compose stop dotnet`):
```bash
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < backups/db_<дата>.dump
docker compose start dotnet
```

**Файлы** (фото консолидации, видео, Excel весов):
```bash
docker compose exec -T dotnet sh -c 'cd /data/node-persist && tar -xzf -' < backups/files_<дата>.tar.gz
```

**Фото РК:**
```bash
docker compose exec -T dotnet sh -c 'cd /data/rk-photos && tar -xf -' < backups/rk_<дата>.tar
```

**`.env`:** `cp backups/env_<дата> .env`

## Проверка копии (раз в месяц)

Развернуть выгрузку базы в отдельную временную базу и убедиться, что она читается:
```bash
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" restore_check'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d restore_check --no-owner' < backups/db_<дата>.dump
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d restore_check -c "select count(*) from wms_ops"'
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" restore_check'
```
