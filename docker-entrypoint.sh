#!/bin/sh
set -e

PERSIST=/app/persist
mkdir -p "$PERSIST/data"

# Инициализируем файлы при первом запуске
[ -f "$PERSIST/vs-users.json" ] || echo '{"users":[]}' > "$PERSIST/vs-users.json"
[ -f "$PERSIST/config.json"   ] || cp /app/backend/config.json.default "$PERSIST/config.json"
[ -f "$PERSIST/empl.csv"      ] || touch "$PERSIST/empl.csv"
mkdir -p "$PERSIST/uploads"

# Подменяем файлы симлинками на персистентный том
ln -sf "$PERSIST/vs-users.json" /app/backend/vs-users.json
ln -sf "$PERSIST/config.json"   /app/backend/config.json
ln -sf "$PERSIST/empl.csv"      /app/empl.csv
rm -rf /app/backend/uploads
ln -sf "$PERSIST/uploads"       /app/backend/uploads

# Подменяем папку data
rm -rf /app/backend/data
ln -sf "$PERSIST/data" /app/backend/data

exec node backend/server.js
