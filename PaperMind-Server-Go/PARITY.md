# PARITY.md — Go 移植对拍与联调记录

对拍拓扑：**Go 版（:9091，WSL arch，`start_server.sh`）vs TS 独立版
（E:\Code\PaperMind-Server，:9092，bun 直跑 `start_ts.sh`）**，共用同一云
Supabase 与同一 uploads 目录。TS 侧开 `ALLOW_GUEST_ACCESS=true` 对齐
Go（=原始 Coze 版）的 guest 语义。TS 独立版是**演进版**（新增 openapi
校验层/强制鉴权/swagger），Go 的事实源是原始版（`PaperMind-源码包.zip`
内的 server/src，可随时解包核对）。

## 第二轮：完整 parity 验证（2026-10-28 深夜）

在第一轮基础上补齐全部空白区，方法论与结论：

| 空白区 | 方法 | 结果 |
| --- | --- | --- |
| 真实登录鉴权 E2E | Supabase signup + admin 确认 + 真实 JWT 双端请求 | **一致**：双端都把写入归属到正确 user_id；坏 token 行为差异属已知（Go=原始版 guest 兜底，独立版 401） |
| 全部 13 个 AI 端点的 prompt 保真 | **录音网关**（`parity_recorder.ts` 挂 9099，罐头响应零 AI 成本）截获双端发出的 /v1/messages 逐字节 diff | **12/13 逐字节一致**（修 1 个 bug 后）；1 处（检索分数微差）为嵌入 API 固有特性 |
| PDF/DOCX 文件提取 | 手工构造 2 页 PDF + 最小 OOXML DOCX，双端上传比对 | **DOCX 提取逐字节一致**；PDF 按页分块一致（\f 优先切分），整文行连接有 `\n\n`(Go/ledongthuc) vs `\n`(TS/mupdf) 的库级微差 |
| 重管理操作（7 项） | 隔离测试用户下 trigger/rebuild-all/process-*/consolidate-tags/migrate 双端执行 + DB 快照对比 | **全过**：响应结构、处理数、process_status、papercore 全一致（快照 nodes 差异定位为独立版演进：垃圾 LLM 输出时独立版跳过建节点，原始版/Go 会降级 upsert——已对 zip 源码核实 rebuild 循环本就不同步节点，Go 忠实） |
| 剩余写接口（9 组） | papernote-style PUT/extract、study-note PUT、materials PUT、draft PATCH、chat 消息、forum 帖、mark-viewed、psl | 严格一致 3 组；4 组差异为时间戳/文件名/id（预期）；pstyle-extract 的 summary 差异为 LLM 非确定性（prompt 已核对逐字一致） |

### 本轮修复（第 5 个 bug）

**tutor prompt 丢换行**（`api/ai.go` buildTutorPrompt 两个分支）：TS 模板
在 `${imageInstruction}` 后各有一个模板换行（ai.ts:899-917），无图时体现
为 `。\n\n【学习纪要`/`。\n\n知识库中尚未`，Go 拼接漏了该 `\n`——prompt
对拍实测差 2 字节定位。修复后 tutor 双路径 prompt 逐字节一致。

### 本轮新认知（不修，已定性）

1. **嵌入 API 批量非确定性**（SiliconFlow bge-m3）：同批次同输入两次
   调用分数整体漂移（python 参照复算证实）；两端各自建索引各得微差
   向量 → TopK/0.3 阈值边界条目偶发翻转（如 suggest-relations 分数
   0.41 vs 0.42、tutor 资料清单个别条目互换）。**实现层面已逐行核对
   等价**（嵌入文本拼接、batch 32、L2 归一化、点积），属外部固有特性。
2. **独立版 TS 契约演进清单**（Go 均忠实原始版，非移植错误）：
   `generate-note/refine-note` 的 `sourceIds` 要 `{id,type}` 对象
   （原始版收任意数组）；`psl/summarize` 的 `chat_session_id` 要 UUID；
   `rebuild-all` 响应键 `total/processed` vs 原始版 `message:"N/N 处理"`；
   垃圾 LLM 输出时跳过知识节点 upsert；PDF 分块算法（\f 优先否则按页
   数均分文本）。
3. **PDF 整文提取的行连接微差**：Go(ledongthuc) 块间 `\n\n`，
   TS(mupdf) `\n`；因切页 `\f` 优先，file_contents 分块不受影响，
   仅 draft 整文字段呈现差异。

## 第一轮对拍结果（2026-10-28，全部通过）

| 层面 | 结果 | 备注 |
| --- | --- | --- |
| 路由表（方法×路径） | 70/70 一致 | `:id`/`{id}` 归一后 |
| GET 读接口 | 24/24 一致 | 规范化（键序+端口）后逐字节相同 |
| 写接口（POST/PUT/DELETE 生命周期） | 6/6 一致 | 含删除后 404 验证 |
| 删除不存在 id | 4/4 一致 | 双端均 500 |
| SSE 流式（ai/chat） | 结构一致 | 头/事件框架/[DONE]/事件数 |
| 上传 → 后台知识构建管线 | 一致 | 双端 tags 逐项相同、知识节点数相同 |
| materials/{id}/file-content | 一致 | 仅 viewUrl 端口/时间戳文件名差异（预期） |
| ai/refresh-index | 一致 | 双端 nodeCount=24 |
| file-contents/search | 一致 | 同关键词结果逐字节相同 |
| 错误形态（缺必填） | 状态码一致 | 响应体差异见下（TS 演进） |

## 发现并修复的 Go 侧 bug（累计 5 个）

1. **DELETE 返回 200 空响应体**（`db/query.go` + `api/respond.go`）
   `Prefer: return=representation` 原先只在有请求体时设置，DELETE 无
   body → PostgREST 回 204 空体 → 空 `json.RawMessage` 在 Go 1.27 下
   marshal 报 `unexpected end of JSON input`，被 `JSON()` 的 `_ =` 静默
   吞掉。修复：按方法（POST/PUT/PATCH/DELETE）设置 Prefer；encode
   失败记日志。影响 5 处 DELETE 路由。
2. **上传后后台分类 panic 击穿进程**（`knowledgebuilder_tags.go:128`，
   真实对拍首枪命中）：资料行 `tags=[]` 时 `tagArr[2:]` 越界（JS
   `arr.slice(2)` 空数组安全，Go 必须守卫）。修复：行循环抽成纯函数
   `kbHierarchyFromRows` 并加长度守卫 + 回归单测；同类 `[2:]` 共 6 处，
   其余 5 处核过已有守卫。
3. **后台协程无 recover**（`materials.go classifyInBackground`）：任何
   后台 panic 直接带崩整个服务。修复：defer recover → 记日志 + 标记
   `process_status=failed`（对齐 TS「上传响应不受后台异常影响」）。
4. **网关错误空文案**（`aiclient/messages.go`）：代理/网关偶发空响应体
   非 2xx 时 `apiHTTPError.Error()` 返回空串，日志与 500 响应都变空。
   修复：空 message 兜底 `AI gateway HTTP <n> (empty error body)` + 单测。
5. **tutor prompt 丢换行**（`api/ai.go` 两个分支，prompt 对拍定位）：
   详见第二轮记录。

## 已知差异（不修）

- **错误响应 envelope**：TS 独立版 openapi 校验层返回
  `{"error","code":"VALIDATION_ERROR","details":[Ajv]}`；Go 返回
  `{"error":"缺少 xx 参数"}`——与原始 TS **逐字一致**（zip 内 ai.ts
  核对过 `缺少 field 参数`）。属 TS 演进，非移植错误。
- **未注册方法**：Go net/http 自动 405，Express 落穿 404。客户端只调
  注册过的路由，无实际影响。
- **kb-graph 布局坐标随机**：双端自身两次调用都不同（TS 自比 312 行
  diff），结构零差异。
- **鉴权策略**：独立版 TS 默认 401 强制鉴权；Go（=原始版）无 token
  静默降级 guest。配好 `SUPABASE_URL`/`SUPABASE_*_KEY` 后 Go 也验真实
  X-Session（新格式 sb_publishable_/sb_secret_ 密钥实测与
  /auth/v1/user 兼容）。
- **视觉 OCR 未移植**：扫描件 PDF 在 Go 版只得空文本（纯 Go 无栅格化
  方案），等价 TS 未配 VISION_API_KEY 的降级路径。

## 联调环境要点

- `.env` 必须显式 `ANTHROPIC_MODEL=glm-5.3-flash`（智谱网关无代码
  默认值 kimi-for-coding，报 400 模型不存在）；`NOTE_MODEL` 同理。
- WSL 内出站走宿主代理 `http://<网关IP>:16888`（Clash TUN 的 fake-ip
  DNS 会掐断 WSL 直连 TLS）；服务需带 `http_proxy/https_proxy` 启动。
- 上传目录默认值不同：Go 是 `<cwd>/uploads`，TS 是 `server/uploads`；
  共用数据时 Go 侧设 `UPLOAD_DIR`。
- 工具链坑：WSL `/tmp` 是 tmpfs（VM 停机即清空，编译产物放 `~`）；
  Git Bash → curl.exe 中文参数会 mojibake（对拍载荷用 ASCII）；mingw
  curl 的 `-F file@` 要用盘符路径；`wsl.exe` 内嵌引号会被吞噬（复杂
  命令写脚本文件再执行）。

## 对拍工具（可重跑）

- `parity_get.sh`：GET 全量对拍（动态取 id、端口/键序归一、diff）
- `parity_write.sh`：写接口生命周期对拍（自动清理）
- `start_server.sh` / `start_ts.sh`：双服务启动（Go 9091 / TS 9092）
