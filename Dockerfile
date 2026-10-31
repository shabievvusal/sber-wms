# Образ Caddy с сайтом внутри (2026-10-31, node убран): фронтенд собирается
# здесь и кладётся в /srv/site — Caddy раздаёт его сам, вместе с Caddyfile.
# Бэкенд — отдельный образ (backend-dotnet/Dockerfile).

# ── сборка фронтенда ──────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /build
COPY frontend-app/package*.json ./
RUN npm ci
COPY frontend-app/ ./
# расширение для WMS — собирается в архив для скачивания с сайта (frontend-app/extension-bundle.js)
COPY extension/ /extension/
RUN npm run build

# ── Caddy ─────────────────────────────────────────────────────────
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-builder /build/dist /srv/site
