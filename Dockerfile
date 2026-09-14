# syntax=docker/dockerfile:1

# ==================== 构建阶段 ====================
FROM node:22-bookworm-slim AS build
WORKDIR /app

# pnpm 版本取自 package.json 的 packageManager 字段
RUN corepack enable

# 先拷全源码再装依赖：client 的 postinstall 会跑 scripts/install-missing-deps.js
# （内部用 depcheck 扫源码补依赖），源码不在场时该步骤会失败。
# 牺牲依赖层缓存换来与本地安装完全一致的行为。
COPY . .

RUN pnpm install --frozen-lockfile

# 前端静态产物。这里刻意留空：客户端会回退到当前页面 origin，
# 与 API 同源，将来换域名 / 挂自定义域名都不需要重新构建。
ENV EXPO_PUBLIC_BACKEND_BASE_URL=""
ENV CI=1
ENV EXPO_NO_TELEMETRY=1
RUN cd client && ./node_modules/.bin/expo export --platform web

# 后端打包（esbuild → server/dist，第三方依赖保持 external）
RUN cd server && pnpm run build

# ==================== 运行阶段 ====================
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# libgomp1：onnxruntime-node（嵌入模型运行时）必需，slim 镜像不自带，缺了会在首次
# 调用嵌入时报 "libgomp.so.1: cannot open shared object file"
# ca-certificates：嵌入模型走 HTTPS 从 hf-mirror 下载
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libgomp1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/test_data ./test_data
COPY --from=build /app/debug ./debug

# 与本地开发保持一致：server 以 server/ 为工作目录解析相对路径
WORKDIR /app/server
EXPOSE 10000
CMD ["node", "dist/index.js"]
