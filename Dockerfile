# ============================================================================
# event-support-server — Cloud Run 用マルチステージ Dockerfile
# ----------------------------------------------------------------------------
# - Stage 1: deps     … 依存パッケージ解決（npm ci でフル）
# - Stage 2: build    … TypeScript を dist/ に出力
# - Stage 3: runtime  … 本番依存のみ + dist/ で軽量化
#
# Cloud Build のデフォルトビルダーは BuildKit を有効化しないため、
# `RUN --mount=type=cache` などの BuildKit 拡張は使わない。
#
# Cloud Run へのデプロイ手順は docs/deploy/cloud-run.md を参照
# ============================================================================

# ---------- Stage 1: deps ---------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- Stage 2: build --------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- Stage 3: runtime ------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

# 本番依存のみインストール（devDependencies を含めない）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ビルド成果物のみコピー
COPY --from=build /app/dist ./dist

# 非 root ユーザーで実行（node イメージに既存の node ユーザー）
USER node

# Cloud Run は $PORT を注入する（既定 8080）。Fastify は 0.0.0.0 を listen 済み
EXPOSE 8080

CMD ["node", "dist/index.js"]
