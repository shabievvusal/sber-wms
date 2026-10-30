#!/bin/sh
# Ежедневная резервная копия сайта (запуск — cron на сервере, см. backup/README.md):
#   db_<дата>.dump      — база PostgreSQL (pg_dump, сжатый формат, восстанавливается pg_restore)
#   files_<дата>.tar.gz — том node-persist: фото консолидации, видео нарушений, config.json
#                         (без почасовых данных data/ГГГГ-ММ-ДД — они больше не нужны)
#   rk_<дата>.tar       — том rk-photos: фото приёмки/отгрузки (JPEG уже сжаты — без gzip)
#   env_<дата>          — .env (пароль базы и прочие секреты)
# Хранятся KEEP_DAYS дней в $BACKUP_DIR. Если задан RCLONE_REMOTE (backup/backup.env) —
# копия ещё и уходит за пределы сервера (Яндекс Диск и т.п.), там хранится REMOTE_KEEP_DAYS.
set -eu

PROJECT_DIR=${PROJECT_DIR:-/opt/sber-wms}
BACKUP_DIR=${BACKUP_DIR:-$PROJECT_DIR/backups}
KEEP_DAYS=${KEEP_DAYS:-7}
MIN_FREE_GB=${MIN_FREE_GB:-8}
RCLONE_REMOTE=${RCLONE_REMOTE:-}
REMOTE_KEEP_DAYS=${REMOTE_KEEP_DAYS:-14}
[ -f "$PROJECT_DIR/backup/backup.env" ] && . "$PROJECT_DIR/backup/backup.env"

cd "$PROJECT_DIR"
mkdir -p "$BACKUP_DIR"
TS=$(date +%F_%H%M)
log() { echo "$(date '+%F %T') $*"; }

# одна копия за раз
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { log "копирование уже идёт — выходим"; exit 0; }

# места мало — не забиваем диск до отказа сайта
FREE_GB=$(df -BG --output=avail "$BACKUP_DIR" | tail -1 | tr -dc '0-9')
if [ "$FREE_GB" -lt "$MIN_FREE_GB" ]; then
  log "ОШИБКА: свободно ${FREE_GB} ГБ (< ${MIN_FREE_GB}) — копия не сделана"
  exit 1
fi

log "старт ($TS)"

# 1. База — согласованный снимок, даже если в неё пишут. Низкий приоритет,
#    чтобы ночная выгрузка не тормозила сайт.
docker compose exec -T postgres sh -c 'nice -n 19 pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 6' > "$BACKUP_DIR/db_$TS.dump.part"
mv "$BACKUP_DIR/db_$TS.dump.part" "$BACKUP_DIR/db_$TS.dump"
log "база: $(du -h "$BACKUP_DIR/db_$TS.dump" | cut -f1)"

# 2. Файлы node (фото консолидации, видео нарушений, config.json)
docker compose exec -T node sh -c 'cd /app/persist && nice -n 19 tar -czf - --exclude="./data/20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]" --exclude=./data/raw_tmp .' > "$BACKUP_DIR/files_$TS.tar.gz.part"
mv "$BACKUP_DIR/files_$TS.tar.gz.part" "$BACKUP_DIR/files_$TS.tar.gz"
log "файлы: $(du -h "$BACKUP_DIR/files_$TS.tar.gz" | cut -f1)"

# 3. Фото РК (тома может не быть на старой версии — тогда пропускаем)
if docker compose exec -T dotnet sh -c 'test -d /data/rk-photos' 2>/dev/null; then
  docker compose exec -T dotnet sh -c 'cd /data/rk-photos && nice -n 19 tar -cf - .' > "$BACKUP_DIR/rk_$TS.tar.part"
  mv "$BACKUP_DIR/rk_$TS.tar.part" "$BACKUP_DIR/rk_$TS.tar"
  log "фото РК: $(du -h "$BACKUP_DIR/rk_$TS.tar" | cut -f1)"
else
  log "фото РК: тома нет — пропущено"
fi

# 4. Секреты
cp .env "$BACKUP_DIR/env_$TS"
chmod 600 "$BACKUP_DIR/env_$TS"

# 5. Старые копии
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db_*' -o -name 'files_*' -o -name 'rk_*' -o -name 'env_*' \) -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.part' -delete

# 6. За пределы сервера (если настроено)
if [ -n "$RCLONE_REMOTE" ]; then
  rclone copy "$BACKUP_DIR" "$RCLONE_REMOTE" --include "*_$TS*" --transfers 2
  rclone delete "$RCLONE_REMOTE" --min-age "${REMOTE_KEEP_DAYS}d"
  log "отправлено в $RCLONE_REMOTE"
fi

log "готово, всего в $BACKUP_DIR: $(du -sh "$BACKUP_DIR" | cut -f1)"
