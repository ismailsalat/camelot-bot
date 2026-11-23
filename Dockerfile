# ---------------------------------------------------------------------------
# Camelot Bot — production image (works as-is on Railway, Fly, Docker, etc.)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# better-sqlite3 is a native module; these are needed to compile it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Default DB location. On Railway, attach a Volume mounted at /data.
ENV DATABASE_PATH=/data/camelot.sqlite
RUN mkdir -p /data

CMD ["node", "dist/index.js"]
