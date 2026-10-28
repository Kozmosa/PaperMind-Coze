# PORTING.md — Express → Go 移植手册

事实源：`server/src/`（TypeScript）。本文件约定各组的文件所有权、
响应格式、端点清单与依赖政策。**改契约先改这里。**

## 包结构图

```text
cmd/server/main.go            ≈ index.ts           入口：CORS/静态目录/SPA/预热钩子
internal/config/              ≈ config/ai.ts       .env 加载 + 全部模型/服务配置
                                + config/paths.ts     （AI 组只读不改）
internal/auth/auth.go         ≈ middleware/auth.ts X-Session → Supabase 验证
                                                     5min 缓存 + guest 静默兜底
internal/db/client.go         ≈ storage/database/  PostgREST 客户端（惰性单例）
internal/db/query.go            supabase-client.ts 查询构建器（select/eq/in/ilike/
                                                     order/limit/single/insert/...）
internal/db/schema.go         ≈ schema.ts +        14 张表的行结构体（含 002~006 迁移列）
                                migrations/*.sql
internal/db/retry.go           runWithRetry        网络类错误重试（*PostgrestError 直抛）
internal/retrieval/           ≈ utils/embedding.ts      Embed/EmbedBatch/余弦/TopK
                                                     vector-store.ts        标签向量库
                                                     unified-vector-index.ts 统一文档索引
                                                     passage-locator.ts     文段定位 Stage 2
                                                     index-refresh.ts       防抖重建
                                                     + WarmStartIndex       启动预热钩子
internal/extracttext/         ≈ utils/extract-text.ts   ExtractText/IsReadableText/
                                                     LooksLikeBrokenGlyphs
internal/api/respond.go       统一响应助手（data/error/success/SSE）
internal/api/router.go        ≈ index.ts:49-83    /api/v1 组装 + health/config（已实现）
internal/api/ai.go            ≈ routes/ai.ts            【AI 组】
internal/api/knowledgebuilder.go ≈ routes/knowledge-builder.ts 【知识构建组】
internal/api/materials.go     ≈ routes/materials.ts      【资料组】
                                + upload.ts + file-contents.ts
internal/api/notes.go         ≈ routes/knowledge-nodes.ts + draft-pool.ts +
                                stickynotes.ts + forums.ts + papernote-style.ts +
                                study-notes.ts            【笔记/社区组】
internal/api/records.go       ≈ routes/reflections.ts + problem-logs.ts +
                                problem-solving-logs.ts + control-center.ts +
                                chat-sessions.ts          【记录组】
```

## 响应 / 错误格式约定（必须完全复刻，助手在 internal/api/respond.go）

| 场景 | TS 写法 | Go 助手 | 响应体 |
| --- | --- | --- | --- |
| 列表/详情成功 | `res.json({ data })` | `api.OK(w, data)` | `200 {"data": ...}` |
| 创建成功 | `res.status(201).json({ data })` | `api.Created(w, data)` | `201 {"data": ...}` |
| 失败 | `res.status(n).json({ error: msg })` | `api.Error(w, n, msg)` / `api.Err` | `{"error": "..."}` |
| 删除/标记 | `res.json({ success: true })` | `api.SuccessTrue(w)` | `200 {"success": true}` |
| SSE（ai/chat、ai/tutor） | `res.write('data: ...')` | `api.StartSSE/WriteSSE/WriteSSEDone` | 头 `text/event-stream; charset=utf-8` 等 |
| upload | 扁平对象 | `api.JSON(w, 200, obj)` | 无 data 包装 |
| psl /summarize | `{ data, overwritten }` | `api.JSON` 自组 | 双键 |

错误码沿用 TS 惯例：参数缺失 400、未登录 401、不存在 404、服务器/DB 500。
TS catch-all 是 `err.message`，Go 用 `err.Error()`；DB 错误透传
`PostgrestError.Error()`（含 Postgres code）。

**鉴权取用户**：TS `(req as any).userId` → Go `auth.UserID(r.Context())`。
读路由的 guest 判定（`userId && userId !== 'guest'`）等价于
`uid != "" && uid != auth.GuestUserID`；写路由的 `'guest'` / `'temp_user'`
兜底值各组按 TS 逐路由对照（notes.go 与 records.go 头部有清单）。

## 数据库访问约定（internal/db）

访问路径是 **Supabase REST（PostgREST）**，不是 pg 直连——TS 侧全部查询经
`getSupabaseClient()`（supabase-client.ts），drizzle 仅作 schema 类型。
凭据：`COZE_SUPABASE_URL` + `COZE_SUPABASE_ANON_KEY`（优先 service role key）。
缺凭据时 `db.Get()` 返回 `ErrNotConfigured`，进程照常启动。

```go
rows, err := db.Get().From(db.TableKnowledgeNodes).
    Select("*").Eq("user_id", uid).Order("created_at", false).Limit(50).
    Rows(r.Context())
var nodes []db.KnowledgeNode
if err := json.Unmarshal(rows, &nodes); err != nil { ... }
```

- 单行：链上 `.Single()`（0 行报错）或 `.MaybeSingle()`（0 行返回字面 `null`）。
- 写操作 `Insert/Update/Delete` 自带 `Prefer: return=representation`，
  等价 TS 的 `.insert(...).select().single()` 尾链。
- 缺列防御（42703）：`errors.As(err, &pe)` 判 `*db.PostgrestError`，
  参照 problem-solving-logs.ts:152-167、control-center.ts:65-93 的降级重试。
- Supabase 网络抖动重试：`db.RunWithRetry(ctx, fn, retries, delayMs)`
  （supabase-client.ts:150 的 runWithRetry）。

## 端点清单（骨架已全部注册；桩 = 501）

### 已实现
- `GET /api/v1/health` → `{"status":"ok"}`（router.go）
- `GET /api/v1/config` → `{"supabaseUrl","supabaseAnonKey"}`（router.go）

### AI 组（internal/api/ai.go ← routes/ai.ts）
| 方法 路径 | TS 行 |
| --- | --- |
| POST /api/v1/ai/chat（SSE） | 35 |
| POST /api/v1/ai/tutor（SSE+图片） | 101 |
| POST /api/v1/ai/knowledge-builder | 479 |
| POST /api/v1/ai/suggest | 565 |
| POST /api/v1/ai/suggest-relations | 645 |
| POST /api/v1/ai/generate-reflection | 1270 |
| POST /api/v1/ai/note-helper | 1368 |
| POST /api/v1/ai/generate-note | 1459 |
| POST /api/v1/ai/refine-note | 1649 |
| POST /api/v1/ai/refresh-index | 1809 |

### 知识构建组（internal/api/knowledgebuilder.go ← routes/knowledge-builder.ts）
| 方法 路径 | TS 行 |
| --- | --- |
| POST /api/v1/knowledge-builder/process-content | 1227（导出 handler 供 upload 直调，:886） |
| POST /api/v1/knowledge-builder/reprocess-material | 1232 |
| POST /api/v1/knowledge-builder/process-study-notes | 1428 |
| POST /api/v1/knowledge-builder/process-materials | 1521 |
| GET  /api/v1/knowledge-builder/graph-data | 1645 |
| GET  /api/v1/knowledge-builder/tag-documents | 2102 |
| POST /api/v1/knowledge-builder/trigger | 2198 |
| POST /api/v1/knowledge-builder/rebuild-all | 2383 |
| POST /api/v1/knowledge-builder/consolidate-tags | 2894 |
| POST /api/v1/knowledge-builder/migrate-add-conflict-column | 2909 |

### 资料组（internal/api/materials.go ← materials.ts + upload.ts + file-contents.ts）
| 方法 路径 | TS 行 |
| --- | --- |
| GET/POST /api/v1/materials | 13/29 |
| PUT/DELETE /api/v1/materials/{id} | 59/243（DELETE 返回 success） |
| GET /api/v1/materials/{id}/file-content | 103 |
| POST /api/v1/upload（multipart，字段 file） | 94 |
| GET /api/v1/file-contents/{draftId} | 9 |
| POST /api/v1/file-contents/search | 30 |

### 笔记/社区组（internal/api/notes.go）
| 方法 路径 | TS 文件:行 |
| --- | --- |
| GET/POST /api/v1/knowledge-nodes；GET/PUT/DELETE /{id} | knowledge-nodes.ts:10/46/30/76/106 |
| GET/POST /api/v1/draft-pool；PATCH/DELETE /{id} | draft-pool.ts:9/25/51/73 |
| GET/POST /api/v1/stickynotes；DELETE /{id} | stickynotes.ts:9/27/50 |
| GET/POST /api/v1/forums；GET/POST /{forumId}/posts | forums.ts:11/25/45/60 |
| GET/PUT /api/v1/papernote-style；POST /extract | papernote-style.ts:15/35/84 |
| GET /api/v1/study-notes/{id}；GET/POST /；PUT/DELETE /{id} | study-notes.ts:9/26/42/76/124 |

### 记录组（internal/api/records.go）
| 方法 路径 | TS 文件:行 |
| --- | --- |
| GET/GET/POST /api/v1/reflections（/、/{id}、/） | reflections.ts:9/25/42 |
| GET/POST /api/v1/problem-logs；DELETE /{id} | problem-logs.ts:9/28/54 |
| POST /summarize、GET/POST /、GET /stats（problem-solving-logs） | problem-solving-logs.ts:33/110/129/178 |
| POST /mark-viewed、GET /recent-records（control-center） | control-center.ts:8/40 |
| GET/POST /api/v1/chat-sessions；GET/POST /{sessionId}/messages | chat-sessions.ts:7/28/49/69 |

## 各组工程师拥有的文件（互不重叠，可并行替换）

| 组 | 文件 | 同时可改 |
| --- | --- | --- |
| AI | `internal/api/ai.go` | `internal/retrieval/`（实现桩） |
| 知识构建 | `internal/api/knowledgebuilder.go` | `internal/retrieval/`、`internal/extracttext/` |
| 资料 | `internal/api/materials.go` | `internal/extracttext/` |
| 笔记/社区 | `internal/api/notes.go` | — |
| 记录 | `internal/api/records.go` | — |

共享文件（`respond.go`、`router.go`、`config/`、`auth/`、`db/`、`cmd/`）
**改动需先在此登记**：响应格式、路由冲突、表结构以本文档为准。
`internal/retrieval` 与 `internal/extracttext` 的**导出签名是契约**，
改签名等于改所有调用方，需在组间周知。

## 依赖政策

1. **优先标准库**。HTTP 路由用 Go 1.22+ `net/http` 的方法模式
   （`mux.HandleFunc("POST /api/v1/ai/chat", h)`），路径参数用 `r.PathValue("id")`。
   **不引入 Web 框架**（gin/echo/chi 均禁止）。
2. 当前第三方依赖仅 1 个（见下），`go.sum` 已生成。新增依赖必须在本节
   登记理由，且默认拒绝。已登记的例外：
   - PDF 文本提取（`internal/extracttext`）：**已登记（引擎组评估结论）**。
     原候选 `github.com/pdfcpu/pdfcpu` 经查 v0.16.2 **没有页面文本提取能力**
     （仅 content/fonts/images/metadata 抽取），作废；改用
     `github.com/ledongthuc/pdf`（rsc.io/pdf 血统、纯 Go、零传递依赖、BSD、
     持续维护，支持逐页提取 + ToUnicode CMap 解码即 CJK），承担 TS 侧
     mupdf/pdf-parse 两级的文本提取。视觉 OCR 兜底无纯 Go 方案（页面栅格化
     缺失），未移植——行为等价于 TS 未配置 VISION_API_KEY 的降级路径，
     详见 `internal/extracttext/pdf.go` 注释与移植 gaps。
   - DOCX/XLSX/PPTX（OOXML 即 zip+xml）：标准库 `archive/zip` +
     `encoding/xml`/`regexp` 足够，对应 TS 的 mammoth/AdmZip 用法
     （extract-text.ts:396-455 本就是手工解 XML；mammoth 部分按其
     raw-text 规则重写，见 ooxml.go 注释）。
3. 不引 pgx：数据库走 Supabase REST（见上）。若未来切 pg 直连，
   在此登记并同步改 `internal/db` 的实现说明。

## 移植时已知的 TS → Go 语义映射

- TS 的 catch-all `err.message` → `err.Error()`；`res.status(500).json({error})`。
- TS `maybeSingle()` 0 行 → PostgREST 对象 Accept 下返回 `null` JSON；
  Go 解到指针为 nil 即 404 分支。
- TS `new Date().toISOString()` 更新 updated_at → 直接让 PostgREST
  `updated_at` 列默认/触发器处理，或显式 `time.Now().UTC()`。
- SSE 错误处理：头未发出走 JSON 500；已发出补 `data: [DONE]`（ai.ts:85-92）。
- upload 后台分类：TS 用 fake req/res 直调 handler（upload.ts:187-216）；
  Go 用 `ProcessContentRequest` 结构体直调知识构建组导出的函数，勿 HTTP 自调。
- `.env` 差异与目录列出的差异：见 README「已知行为差异」。
