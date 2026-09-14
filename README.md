# PaperMind

AI 驱动的个人知识管理学习应用 —— 一间"第二大脑书房"：上传学习资料，自动提取文本并构建知识图谱，基于 RAG 的智能导师随问随答（带来源引用），再配以学习笔记、反思报告与社区交流，让知识被梳理、连接、生长。

> 项目处于 MVP 阶段（`main` 已合并 Mvp2：真实 AI 对话、反思报告生成、文件上传均已接入）。

## 核心功能

| 模块                        | 说明                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| AI 助手（Tutor）            | 基于 RAG 的流式问答。三层检索：指定知识节点 → 统一向量索引（BGE-M3 中文嵌入 + 标签加成）→ 降级加载；回答带 `【来源：…】` 引用，支持图片上传 |
| 知识库                      | 知识图谱可视化、知识节点管理（papercore / 标签体系）                                                                                        |
| 知识构建器                  | 资料 → 知识节点的加工与归类流程                                                                                                             |
| 资料管理                    | PDF / Word / PPT 上传、文本提取、文件夹层级选择、自动 / 强制分类                                                                            |
| 学习笔记                    | 笔记编辑器 + NoteHelper AI 辅助（全屏块编辑、LaTeX、风格偏好）                                                                              |
| 反思报告（Reflection Mind） | AI 生成学习反思报告与图表                                                                                                                   |
| 问题解决日志                | 学习过程中的 QA 日志                                                                                                                        |
| 草稿池                      | 待处理资料托盘                                                                                                                              |
| 社区                        | 便利贴瀑布流、论坛讨论                                                                                                                      |
| 控制中心 / 登录             | 快捷入口聚合 / Supabase Auth                                                                                                                |

检索与引用的完整工作流见 [docs/PaperMind-Architecture.md](docs/PaperMind-Architecture.md)，视觉规范见 [DESIGN.md](DESIGN.md)。

## 技术栈

- **前端（`client/`）**：Expo 54 · React Native 0.81 · React 19 · expo-router（Tabs + Stack）· Tailwind CSS（uniwind 运行时）· Supabase Auth
- **后端（`server/`）**：Express 4 · TypeScript（tsx watch 热重载）· Drizzle ORM + Supabase（PostgreSQL）
- **AI**：Anthropic 兼容网关流式生成（SSE）；中文嵌入走 Embedding API（`BAAI/bge-m3`，1024 维），服务端不做本地推理
- **文本提取**：pdf-parse（PDF）· mammoth（Word）· adm-zip / xml2js（PPT）

## 项目结构

```text
├── client/                     # React Native / Expo 前端
│   ├── app/                    # expo-router 路由（仅路由配置）
│   │   ├── _layout.tsx         # 根布局（Stack）
│   │   ├── (tabs)/             # 底部 Tab：控制中心 / 知识库 / AI 助手 / 社区 / 我的
│   │   └── *.tsx               # Stack 页面：ai-chat、reflection、knowledge-builder 等
│   ├── screens/                # 页面实现（与 app/ 路由一一对应）
│   ├── components/             # 可复用组件（Screen 容器等）
│   ├── contexts/  hooks/  utils/
│   └── global.css              # 主题 design tokens（tailwindcss 入口）
├── server/                     # Express.js 后端
│   └── src/
│       ├── index.ts            # 入口（默认端口 9091）
│       ├── config/ai.ts        # AI 网关与模型配置
│       ├── routes/             # ai、knowledge-*、materials、upload、reflections 等 16 组 REST 路由
│       ├── middleware/         # Supabase Auth 鉴权
│       ├── storage/database/   # schema 定义 + Supabase 客户端
│       └── utils/              # 文本提取、向量索引（UnifiedVectorIndex / TagVectorStore）
├── debug/                      # 浏览器调试页（full-app-test.html 等全流程联调页）
├── docs/                       # 架构文档
├── DESIGN.md                   # 视觉设计规范
├── AGENTS.md                   # 开发规范（目录 / 路由 / 样式约定，改代码前必读）
├── .cozeproj/  .coze           # 扣子平台脚手架脚本与配置（禁止修改）
└── patches/                    # expo@54.0.33 HMR 补丁（仅云端预览环境生效）
```

## 安装与运行指南（从零启动）

### 0. 环境要求

| 依赖              | 版本 / 说明                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Node.js           | ≥ 20（推荐 22 LTS；扣子云端运行环境为 nodejs-24）                                                  |
| pnpm              | ≥ 9（仓库锁定 `pnpm@9.0.0`，**只能用 pnpm 安装依赖**，preinstall 脚本会拦截 npm / yarn）           |
| Git Bash          | Windows 用户需要（启动脚本是 `.sh`，安装 Git for Windows 即自带）；macOS / Linux 自带 bash 即可    |
| Supabase 项目     | 云数据库 + 登录鉴权（免费额度即可），<https://supabase.com> 注册创建                               |
| AI 网关 API Key   | 任意 Anthropic 兼容接口（如 Kimi / DeepSeek / 智谱开放平台），用于 AI 对话与反思报告生成           |
| Embedding API Key | 任意 OpenAI 兼容 Embedding 接口（如 SiliconFlow 的 `BAAI/bge-m3`，有免费额度），用于知识库向量检索 |

> 本项目源自扣子编程平台导出，本地开发**不需要** Coze CLI 或扣子账号；`pnpm dev` 与云端的 `coze dev` 执行的是同一份启动脚本（`.cozeproj/scripts/dev_run.sh`）。

启用 pnpm（任选其一）：

```bash
corepack enable && corepack prepare pnpm@9.0.0 --activate   # 推荐，Node 自带 corepack
# 或
npm install -g pnpm@9.0.0
```

### 1. 安装依赖

在**仓库根目录**执行（pnpm workspace 会同时安装 client 与 server）：

```bash
pnpm install
```

说明：

- 安装时会自动应用 expo 补丁（`patches/expo@54.0.33.patch`，仅云端预览环境需要，本地无影响）；
- client 的 postinstall 会执行 `scripts/install-missing-deps.js` 自动补齐缺失依赖；
- 网络不佳时可改用镜像：`pnpm install --registry=https://registry.npmmirror.com`。

### 2. 配置环境变量

```bash
cp .env.example .env
```

最少可用配置只需填 4 个值（Supabase 项目同一个，两个变量填同一套值）：

```ini
COZE_SUPABASE_URL=https://xxxx.supabase.co     # Supabase → Project Settings → API
COZE_SUPABASE_ANON_KEY=eyJ...                  # 同上（Publishable key）
SUPABASE_URL=https://xxxx.supabase.co          # 与上面相同
SUPABASE_SERVICE_ROLE_KEY=eyJ...               # 同上（Secret key，server 端读写用）
```

要使用 AI 对话 / 反思报告，再填 AI 网关（不填则 AI 类接口不可用，其余功能正常）：

```ini
ANTHROPIC_BASE_URL=https://api.example.com     # Anthropic 兼容网关地址
ANTHROPIC_API_KEY=sk-...
# ANTHROPIC_MODEL=kimi-for-coding              # 可选，默认 kimi-for-coding
```

前端登录需要（与 server 同一个 Supabase 项目）：

```ini
EXPO_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

完整变量说明见下方[环境变量](#环境变量)表格与 `.env.example` 内注释。

### 3. 初始化数据库（首次运行必做）

迁移脚本需要二选一的高权限凭据（写在 `.env` 中）：

- `SUPABASE_ACCESS_TOKEN`（推荐）：Supabase Dashboard → Account → Access Tokens 生成，走 Management API，无需数据库密码；
- `SUPABASE_DB_URL`：`postgresql://postgres:<密码>@...`（Project Settings → Database；注意直连地址仅 IPv6，本地无 IPv6 请用 Connection pooler 的 URI）。

```bash
# 应用全部迁移（幂等，执行记录在 schema_migrations 表）
cd server && npx tsx scripts/apply-migrations.ts

# 校验关键表 / 列是否就绪
npx tsx scripts/verify-migrations.ts
```

可选：灌入演示数据（需先完成上一步并在根目录启动服务，见步骤 4）：

```bash
# 演示场景包（推荐，含社区 / 反思 / 会话等全套数据，资料在 test_data/scenario）
npx tsx scripts/seed-scenario.ts
# 或 MVP 最小种子（仅纪要 + 资料）
npx tsx scripts/seed-mvp1.ts
```

### 4. 启动开发环境

```bash
# 回到仓库根目录
pnpm dev
```

一键启动前后端（自动清理 9091 / 5001 端口占用并重启，等价于扣子云端的 `coze dev`）：

- **前端（Expo Web）**：<http://localhost:5001>
- **后端（Express）**：<http://localhost:9091>，健康检查 `GET /api/v1/health`
- 日志输出到 `logs/client.log` 与 `logs/server.log`

也可以分开手动启动（调试更直观）：

```bash
# 终端 1：后端（tsx watch 热重载，端口 9091）
cd server && pnpm dev

# 终端 2：前端（Expo Web dev server，端口 5001）
cd client && npx expo start --web --port 5001
```

> 向量检索依赖 Embedding API（默认 SiliconFlow `BAAI/bge-m3`），需在 `.env` 配置 `EMBEDDING_API_KEY`；未配置时服务可正常启动，仅检索链路不可用。首次提问会比后续慢一些——服务启动后要在后台为已有标签与资料建立向量索引。

### 5. 生产构建与运行

```bash
pnpm build   # 安装依赖并构建 server 到 server/dist（esbuild 打包）
pnpm start   # 生产模式运行，PORT 默认 5000（可环境变量覆盖）
```

### 常见问题

- **`pnpm install` 被拦截 / 报 only-allow**：本仓库限定 pnpm，请勿用 npm / yarn。
- **Windows 下 `pnpm dev` 报 bash 找不到**：安装 Git for Windows（自带 bash）后重开终端。
- **server 启动即退出**：大概率是 `.env` 缺 `COZE_SUPABASE_URL` / `COZE_SUPABASE_ANON_KEY`。
- **前端请求后端 404 / 跨域**：确认后端 9091 已启动；`EXPO_PUBLIC_BACKEND_BASE_URL` 需指向后端地址（`pnpm dev` 会自动注入）。
- **上传资料后无反应**：首次运行需要数据库迁移完成（步骤 3），且 AI 网关 Key 已配置。

## 环境变量

| 变量                                                         | 必填 | 说明                                                  |
| ------------------------------------------------------------ | :--: | ----------------------------------------------------- |
| `COZE_SUPABASE_URL` / `COZE_SUPABASE_ANON_KEY`               |  ✅  | Supabase 项目地址与 anon key（server 启动硬依赖）     |
| `COZE_SUPABASE_SERVICE_ROLE_KEY`                             | 建议 | server 端完整读写权限                                 |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY`                         | 可选 | 部分模块使用的等价变量                                |
| `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` | 建议 | 前端直连 Supabase（登录鉴权）                         |
| `EXPO_PUBLIC_BACKEND_BASE_URL`                               | 可选 | 后端地址，`pnpm dev` 自动注入 `http://localhost:9091` |
| `EMBEDDING_API_KEY`                                          |  ✅  | Embedding 密钥；缺失时服务仍可启动，但检索链路不可用  |
| `EMBEDDING_API_BASE` / `EMBEDDING_MODEL`                     | 可选 | 默认 `https://api.siliconflow.cn/v1` / `BAAI/bge-m3`  |
| `VISION_BASE_URL` / `VISION_MODEL`                           | 可选 | 扫描件 OCR 兜底（OpenAI 兼容端点），见 `.env.example` |
| `PORT`                                                       | 可选 | server 端口，默认 9091                                |
| `COZE_PROJECT_ID` 等                                         | 可选 | 扣子云端注入的平台变量，本地留空                      |

AI 网关走 Anthropic 兼容接口：`ANTHROPIC_API_KEY` 必填，`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 可选（代码默认 `kimi-for-coding`，实际部署按网关填写）。若使用推理模型，注意思考内容也计入 `max_tokens`，预算需留足。完整清单见 `.env.example`。

## 常用命令

```bash
pnpm dev          # 启动开发环境（自动清理端口占用并重启前后端）
pnpm build        # 生产构建
pnpm start        # 生产模式运行
pnpm -w lint:client   # client 静态校验（TSC + ESLint）
pnpm -w lint:server   # server 静态校验（TSC + ESLint）
pnpm -w validate      # 全量校验（两端 lint + 格式检查）
pnpm -w format        # 代码格式化（prettier，含 tailwind class 排序）
```

## 调试工具

`debug/` 下提供免构建的浏览器联调页（server 已静态挂载在 <http://localhost:9091/debug/>）：`full-app-test.html` 覆盖 AI 对话、反思报告生成、文件上传的全流程接口调试；另有知识图谱（`knowledge-graph-test.html`）与标签树（`tag-tree.html`）可视化测试页。

## 提交包说明

本仓库以源码 zip 包形式提交（不含任何依赖与运行时产物），包含：

- **源代码**：`client/`（Expo 前端）、`server/`（Express 后端，含 `migrations/` 数据库迁移与 `scripts/` 数据脚本）
- **工程包与配置**：`.cozeproj/`（扣子平台工程脚手架：dev / build / run / validate 编排脚本）、`.coze`（平台工程配置）、`package.json` + `pnpm-lock.yaml` + `pnpm-workspace.yaml`（依赖锁定）、`.env.example`（环境变量模板）、`patches/`（expo 补丁）
- **文档与测试数据**：`README.md`、`docs/`（架构文档）、`DESIGN.md`、`debug/`（浏览器联调页）、`test_data/`（种子脚本测试数据）

已排除（解压后按上文步骤还原）：`node_modules/`（依赖，`pnpm install` 重装）、`.env`（密钥，从 `.env.example` 复制填写）、`logs/`、`server/uploads/`（运行时自动重建）、`.git/` 等本地开发产物。

解压后进入目录，依次执行「安装与运行指南」的步骤 1 → 4 即可完整运行。
