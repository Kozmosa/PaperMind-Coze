# PaperMind

AI 驱动的个人知识管理学习应用 —— 一间"第二大脑书房"：上传学习资料，自动提取文本并构建知识图谱，基于 RAG 的智能导师随问随答（带来源引用），再配以学习笔记、反思报告与社区交流，让知识被梳理、连接、生长。

> 项目处于 MVP 阶段（`main` 已合并 Mvp2：真实 AI 对话、反思报告生成、文件上传均已接入）。

## 核心功能

| 模块 | 说明 |
|------|------|
| AI 助手（Tutor） | 基于 RAG 的流式问答。三层检索：指定知识节点 → 统一向量索引（BGE 中文嵌入 + 标签加成）→ 降级加载；回答带 `【来源：…】` 引用，支持图片上传 |
| 知识库 | 知识图谱可视化、知识节点管理（papercore / 标签体系） |
| 知识构建器 | 资料 → 知识节点的加工与归类流程 |
| 资料管理 | PDF / Word / PPT 上传、文本提取、文件夹层级选择、自动 / 强制分类 |
| 学习笔记 | 笔记编辑器 + NoteHelper AI 辅助（全屏块编辑、LaTeX、风格偏好） |
| 反思报告（Reflection Mind） | AI 生成学习反思报告与图表 |
| 问题解决日志 | 学习过程中的 QA 日志 |
| 草稿池 | 待处理资料托盘 |
| 社区 | 便利贴瀑布流、论坛讨论 |
| 控制中心 / 登录 | 快捷入口聚合 / Supabase Auth |

检索与引用的完整工作流见 [docs/PaperMind-Architecture.md](docs/PaperMind-Architecture.md)，视觉规范见 [DESIGN.md](DESIGN.md)。

## 技术栈

- **前端（`client/`）**：Expo 54 · React Native 0.81 · React 19 · expo-router（Tabs + Stack）· Tailwind CSS（uniwind 运行时）· Supabase Auth
- **后端（`server/`）**：Express 4 · TypeScript（tsx watch 热重载）· Drizzle ORM + Supabase（PostgreSQL）
- **AI**：Anthropic 兼容网关流式生成（SSE），本地嵌入模型 `Xenova/bge-small-zh-v1.5`（@huggingface/transformers，无需外部嵌入 API）
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

## 快速开始

环境要求：Node ≥ 20、pnpm ≥ 9（本仓库锁定 `pnpm@9.0.0`，禁止使用 npm / yarn 安装依赖）。

```bash
# 1. 安装依赖（根目录执行，会同时安装 client 与 server）
pnpm install

# 2. 配置环境变量
cp .env.example .env
#    至少填写 COZE_SUPABASE_URL 与 COZE_SUPABASE_ANON_KEY，否则 server 无法启动

# 3. 启动前后端（等价于扣子云端的 coze dev）
pnpm dev
```

启动后：

- **前端（Expo Web）**：<http://localhost:5001>
- **后端（Express）**：<http://localhost:9091>，健康检查 `GET /api/v1/health`
- 日志输出到 `logs/client.log` 与 `logs/server.log`

> 本项目源自扣子编程平台导出，本地开发**不需要** Coze CLI 或扣子账号；`pnpm dev` 与 `coze dev` 执行的是同一份启动脚本（`.cozeproj/scripts/dev_run.sh`）。

## 环境变量

| 变量 | 必填 | 说明 |
|------|:----:|------|
| `COZE_SUPABASE_URL` / `COZE_SUPABASE_ANON_KEY` | ✅ | Supabase 项目地址与 anon key（server 启动硬依赖） |
| `COZE_SUPABASE_SERVICE_ROLE_KEY` | 建议 | server 端完整读写权限 |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | 可选 | 部分模块使用的等价变量 |
| `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` | 建议 | 前端直连 Supabase（登录鉴权） |
| `EXPO_PUBLIC_BACKEND_BASE_URL` | 可选 | 后端地址，`pnpm dev` 自动注入 `http://localhost:9091` |
| `PORT` | 可选 | server 端口，默认 9091 |
| `COZE_PROJECT_ID` 等 | 可选 | 扣子云端注入的平台变量，本地留空 |

AI 网关（Anthropic 兼容接口）通过环境变量配置（`ANTHROPIC_API_KEY` 必填、`ANTHROPIC_BASE_URL` 可选），默认模型 `kimi-for-coding`，见 `.env.example`。

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

`debug/` 下提供免构建的浏览器联调页：`full-app-test.html` 覆盖 AI 对话、反思报告生成、文件上传的全流程接口调试；另有知识图谱（`knowledge-graph-test.html`）与标签树（`tag-tree.html`）可视化测试页。
