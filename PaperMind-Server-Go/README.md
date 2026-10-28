# PaperMind-Server-Go

`server/`（Express + TypeScript）的 Go 移植版。当前为**地基阶段骨架**：
入口、静态目录、鉴权、数据库访问层、检索/文本提取契约已就位，
业务路由以 501 桩的形式注册（替换计划见 [PORTING.md](./PORTING.md)）。

- 模块：`github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go`
- Go 版本：1.27（`go.mod`）
- 依赖：**零第三方依赖**（数据库走 Supabase REST = 标准库 HTTP；路由用 Go 1.22+ `net/http` 方法模式）

## 构建与运行

```bash
# 形式 A —— 从仓库根（E:\Code\PaperMind-Coze）执行，用 -C 进入模块：
go -C PaperMind-Server-Go build ./...    # 编译检查（go build -C PaperMind-Server-Go ./... 同效）
go -C PaperMind-Server-Go test ./...     # 退出码 0（当前无测试文件）
go -C PaperMind-Server-Go vet ./...

# 形式 B —— 从本目录（PaperMind-Server-Go/）执行，直接跑：
go build ./...          # 编译检查
go run ./cmd/server     # 启动（默认端口 9091）

# 或产出二进制
go build -o papermind-server.exe ./cmd/server
./papermind-server.exe
```

> ⚠️ 常见失败：`go: chdir PaperMind-Server-Go: The system cannot find the file specified.`
> —— 这是 `-C PaperMind-Server-Go` 的**相对路径以当前工作目录为基准**导致的：
> 若当前目录已经是 `PaperMind-Server-Go/`（或任何不含该子目录的目录），
> 再 `-C PaperMind-Server-Go` 就会去找 `PaperMind-Server-Go/PaperMind-Server-Go`。
> 此时请去掉 `-C` 直接 `go build ./...`（形式 B），或先回到仓库根（形式 A）。

健康检查：`GET http://localhost:9091/api/v1/health` → `{"status":"ok"}`
运行期配置：`GET http://localhost:9091/api/v1/config` → `{"supabaseUrl":"...","supabaseAnonKey":"..."}`

**工作目录约定**：请从 `PaperMind-Server-Go/` 目录启动。相对路径
（`../test_data`、`../debug`、`../client/dist`）与 TS 版从 `server/` 启动时的
`../` 指向相同的仓库根相对目标。**唯一例外是 uploads**：TS 默认落在
`server/uploads`，Go 默认落在 `<cwd>/uploads`——两版共用上传数据时显式设
`UPLOAD_DIR=../server/uploads`。

## .env 查找顺序

沿用 TS 语义（`server/src/config/ai.ts:15-18`）：先找 `<cwd>/.env`，
不存在再找 `<cwd>/../.env`，只加载先命中的那一份。从本目录启动时
`../.env` 即仓库根 `.env`，与 TS 版共用同一份配置。
差异：Go 版 .env 不覆盖进程已注入的环境变量（标准 dotenv 语义）。

## 环境变量清单

| 变量 | 默认值 | 用途（读取方） |
| --- | --- | --- |
| `PORT` | `9091` | 监听端口（`cmd/server`，对应 index.ts:26） |
| `UPLOAD_DIR` | `<cwd>/uploads` | 上传文件目录（`internal/config`，对应 paths.ts:10） |
| `CLIENT_DIST_DIR` | `../client/dist` | 前端静态产物目录，存在时启用 SPA 回退（index.ts:87） |
| `SERVE_PROJECT_FILES` | 关 | `true` 时把仓库根挂到 `/projects`（**会暴露 .env，仅本地**，index.ts:44） |
| `BACKEND_BASE_URL` | `http://localhost:<PORT>` | materials file-content 拼 viewUrl（materials.ts:220） |
| `ANTHROPIC_API_KEY` | 空 | AI 网关 key，缺失时服务可启动、AI 接口报错（ai.ts:8） |
| `ANTHROPIC_BASE_URL` | 空（直连官方） | Anthropic 兼容网关地址（ai.ts:24） |
| `ANTHROPIC_MODEL` | `kimi-for-coding` | 主模型（ai.ts:43） |
| `NOTE_MODEL` | `deepseek-chat` | 笔记生成快模型（ai.ts:47；注意默认值在智谱网关不存在，见根仓库提交 23b8ada） |
| `VISION_API_KEY` | 回落 `ANTHROPIC_API_KEY` | 视觉 OCR key（ai.ts:58） |
| `VISION_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容视觉端点（ai.ts:59） |
| `VISION_MODEL` | `deepseek-v4-flash-vision-exp` | 视觉模型（ai.ts:60） |
| `EMBEDDING_API_KEY` | 空 | 嵌入 API key，缺失时检索链路不可用（embedding.ts:11） |
| `EMBEDDING_API_BASE` | `https://api.siliconflow.cn/v1` | OpenAI 兼容嵌入端点（embedding.ts:12） |
| `EMBEDDING_MODEL` | `BAAI/bge-m3` | 嵌入模型，1024 维（embedding.ts:13） |
| `COZE_SUPABASE_URL` | 空 | Supabase 项目地址（`internal/db`，supabase-client.ts:85） |
| `COZE_SUPABASE_ANON_KEY` | 空 | anon key（发布密钥） |
| `COZE_SUPABASE_SERVICE_ROLE_KEY` | 空 | 服务角色 key，优先于 anon 使用（绕过 RLS） |
| `SUPABASE_URL` | 空 | 鉴权中间件用（auth.ts:18） |
| `SUPABASE_SERVICE_ROLE_KEY` | 空 | 鉴权用 key，优先（auth.ts:19） |
| `SUPABASE_ANON_KEY` | 空 | 鉴权用 key 兜底（auth.ts:19） |
| `EXPO_PUBLIC_SUPABASE_URL` | 回落 `COZE_SUPABASE_URL` | `/api/v1/config` 下发（index.ts:61） |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | 回落 `COZE_SUPABASE_ANON_KEY` | 同上（index.ts:62-63） |

> `SUPABASE_DB_URL` / `SUPABASE_ACCESS_TOKEN` 仅被 TS 侧迁移脚本
> （`server/scripts/apply-migrations.ts`）使用，Go 服务本身不读。

## 目录结构

```
PaperMind-Server-Go/
├── cmd/server/main.go      # 入口：端口/CORS/静态目录/SPA/预热钩子（≈ index.ts）
├── internal/config/        # .env + 环境变量 + 模型配置（≈ config/ai.ts + paths.ts）
├── internal/auth/          # X-Session → Supabase 验证 + 5min 缓存 + guest 兜底
├── internal/db/            # Supabase REST (PostgREST) 客户端 + 全部表结构体
├── internal/retrieval/     # 检索引擎契约桩（embedding/标签库/统一索引/文段定位）
├── internal/extracttext/   # 文本提取契约桩（PDF/DOCX/PPTX/XLSX/TXT…）
├── internal/api/           # 路由注册 + 响应助手 + 5 个业务组桩文件（501）
├── go.mod
├── README.md
└── PORTING.md              # 移植手册：分组 ownership / 端点清单 / 约定
```

## 与 TS 版的已知行为差异

1. `.env` 不覆盖进程环境变量（TS 的 supabase-client.loadEnv 为 `override:true`，
   属历史行为，不复刻，见 PORTING.md）。
2. Coze 平台的 Python 工作负载身份兜底（supabase-client.ts:37-74）不移植；
   云端部署请用真实环境变量。
3. `net/http.FileServer` 对无 index.html 的目录会列目录（express.static 不会）；
   如需对齐可后续在静态包装层禁掉，当前仅影响 `/projects`、`/test-data`。
