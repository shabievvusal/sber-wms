#!/bin/sh
set -e

PERSIST=/app/persist
mkdir -p "$PERSIST/data"

# Инициализируем файлы при первом запуске
[ -f "$PERSIST/config.json"   ] || cp /app/backend/config.json.default "$PERSIST/config.json"
mkdir -p "$PERSIST/uploads"

# Подменяем файлы симлинками на персистентный том
ln -sf "$PERSIST/config.json"   /app/backend/config.json
rm -rf /app/backend/uploads
ln -sf "$PERSIST/uploads"       /app/backend/uploads

# Подменяем папку data
rm -rf /app/backend/data
ln -sf "$PERSIST/data" /app/backend/data

exec node backend/server.js
