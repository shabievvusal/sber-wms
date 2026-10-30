# ───────────────────────────────────────────────────────────────
# Stage 1: сборка React-фронтенда — редизайн `frontend-app/` (раньше был
# сиблинг-папкой `new zlp` со своим доп.контекстом "newzlp", подключалась
# отдельно от основного build context; после объединения фронтенда и
# бэкенда в один репозиторий (2026-07-15, чтобы можно было залить одним
# проектом на GitHub) — обычная подпапка внутри того же контекста, доп.
# контекст в docker-compose.yml убран). Не оригинальный `frontend/app`
# (тот остался нетронутым как есть — исходный снимок оригинала, не
# используется в сборке). Собирается в dist/ так же (vite build),
# server.js по-прежнему раздаёт ./frontend/app/dist/ — путь ниже не
# меняется (совпадение имени с оригинальным `frontend/app/` — только
# путь ВНУТРИ финального образа, не имеет отношения к исходной папке).
# ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /build

COPY frontend-app/package*.json ./
RUN npm ci

COPY frontend-app/ ./
# расширение для WMS — собирается в архив для скачивания с сайта (frontend-app/extension-bundle.js)
COPY extension/ /extension/
RUN npm run build


# ───────────────────────────────────────────────────────────────
# Stage 2: production Node.js runtime
# ───────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

# ca-certificates — исходящий HTTPS (Telegram); wget — для отладки в контейнере.
# .NET в образе node больше нет: утилиты tools/* удалены (2026-10-31), node
# не запускает ни одного .NET-процесса (сайт на .NET — отдельный контейнер dotnet).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app


# ───────────────────────────────────────────────────────────────
# Backend dependencies (FIX)
# ───────────────────────────────────────────────────────────────
WORKDIR /app/backend

COPY backend/package*.json ./

RUN npm ci --omit=dev


# ───────────────────────────────────────────────────────────────
# Backend source code
# ───────────────────────────────────────────────────────────────
WORKDIR /app

COPY backend/ ./backend/


# ───────────────────────────────────────────────────────────────
# Frontend build
# ───────────────────────────────────────────────────────────────
COPY --from=frontend-builder /build/dist ./frontend/app/dist/


# ───────────────────────────────────────────────────────────────
# config
# ───────────────────────────────────────────────────────────────
RUN echo '{"intervalMinutes":5,"pageSize":500,"connectionMode":"browser"}' > backend/config.json.default \
    && mkdir -p backend/data


# ───────────────────────────────────────────────────────────────
# entrypoint
# ───────────────────────────────────────────────────────────────
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3009

ENTRYPOINT ["./docker-entrypoint.sh"]