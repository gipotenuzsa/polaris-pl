# Polaris: сервер + веб-клиент (PWA) в одном образе. Подходит для Render (free) и любого VPS.
#   docker build -t polaris .
#   docker build --build-arg WITH_BROWSER=1 -t polaris .   # с Chromium для инструмента «браузер» (нужно >512 МБ ОЗУ)
#   docker build --build-arg WITH_WEB=0 -t polaris .       # только API, без веб-клиента

# ── 1. Сервер ────────────────────────────────────────────────────────────────
FROM node:22-slim AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json server/tsconfig.build.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

# ── 2. Веб-клиент (Expo → статическая сборка) ────────────────────────────────
FROM node:22-slim AS web-build
ARG WITH_WEB=1
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN if [ "$WITH_WEB" = "1" ]; then npm ci --no-audit --no-fund; fi
COPY client/ ./
COPY scripts /app/scripts
RUN if [ "$WITH_WEB" = "1" ]; then node /app/scripts/build-web.mjs /out/web; else mkdir -p /out/web; fi

# ── 3. Рабочий образ ─────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ARG WITH_BROWSER=0
ENV NODE_ENV=production \
    PORT=10000 \
    NODE_OPTIONS=--max-old-space-size=384 \
    BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji \
      && rm -rf /var/lib/apt/lists/*; \
    fi
WORKDIR /app
COPY --from=server-build /app/server/node_modules server/node_modules
COPY --from=server-build /app/server/dist server/dist
COPY server/package.json server/
COPY --from=web-build /out/web server/public
COPY supabase/migrations supabase/migrations
# Каталог для локальных файлов (если не подключён Supabase Storage); диск на Render бесплатном тарифе временный
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
