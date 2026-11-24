FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv make g++ ca-certificates git ffmpeg libopus0 fonts-dejavu-core tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tv ./tv
RUN cd tv && npm ci --omit=dev && bash scripts/prepare-cloud.sh && rm -rf _slopsoil_upstream .verified-source-downloads
ENV NODE_ENV=production DATABASE_PATH=/data/camelot.sqlite
RUN mkdir -p /data
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "dist/index.js"]
