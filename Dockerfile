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
RUN npm run build


# ───────────────────────────────────────────────────────────────
# Stage 2: сборка .NET инструментов
# ───────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS dotnet-builder

WORKDIR /tools

COPY tools/ ./

RUN dotnet publish SaveFetchedData/SaveFetchedData.csproj \
        -c Release -o /out/SaveFetchedData \
        --self-contained false && \
    dotnet publish MissingWeightRebuild/MissingWeightRebuild.csproj \
        -c Release -o /out/MissingWeightRebuild \
        --self-contained false && \
    dotnet publish WeightScan/WeightScan.csproj \
        -c Release -o /out/WeightScan \
        --self-contained false && \
    dotnet publish ArticleSpeeds/ArticleSpeeds.csproj \
        -c Release -o /out/ArticleSpeeds \
        --self-contained false && \
    dotnet publish EmployeePerformance/EmployeePerformance.csproj \
        -c Release -o /out/EmployeePerformance \
        --self-contained false && \
    dotnet publish SavePlacementData/SavePlacementData.csproj \
        -c Release -o /out/SavePlacementData \
        --self-contained false && \
    dotnet publish SaveReceivingData/SaveReceivingData.csproj \
        -c Release -o /out/SaveReceivingData \
        --self-contained false && \
    dotnet publish SaveRemainsData/SaveRemainsData.csproj \
        -c Release -o /out/SaveRemainsData \
        --self-contained false


# ───────────────────────────────────────────────────────────────
# Stage 3: production Node.js runtime
# ───────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

# .NET runtime + зависимости
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        wget \
        libvips \
    && wget https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O /tmp/ms.deb \
    && dpkg -i /tmp/ms.deb \
    && rm /tmp/ms.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends dotnet-runtime-9.0 \
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
# .NET tools
# ───────────────────────────────────────────────────────────────
COPY --from=dotnet-builder /out/SaveFetchedData       ./tools/SaveFetchedData/bin/Release/net9.0/
COPY --from=dotnet-builder /out/MissingWeightRebuild  ./tools/MissingWeightRebuild/bin/Release/net9.0/
COPY --from=dotnet-builder /out/WeightScan            ./tools/WeightScan/bin/Release/net9.0/
COPY --from=dotnet-builder /out/ArticleSpeeds         ./tools/ArticleSpeeds/bin/Release/net9.0/
COPY --from=dotnet-builder /out/EmployeePerformance   ./tools/EmployeePerformance/bin/Release/net9.0/
COPY --from=dotnet-builder /out/SavePlacementData     ./tools/SavePlacementData/bin/Release/net9.0/
COPY --from=dotnet-builder /out/SaveReceivingData     ./tools/SaveReceivingData/bin/Release/net9.0/
COPY --from=dotnet-builder /out/SaveRemainsData       ./tools/SaveRemainsData/bin/Release/net9.0/


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