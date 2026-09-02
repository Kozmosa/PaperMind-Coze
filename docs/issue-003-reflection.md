# 对照架构规格盘点 Reflection 反思助手实现缺口

> 状态：已创建为 GitHub issue #6（https://github.com/Kozmosa/PaperMind-Coze/issues/6），2026-09-02。
> 盘点日期：2026-09-02。规格依据：`docs/PaperMind-Architecture.md`「二、Reflection Mind（反思助手）工作流」2.1-2.4 节。

## 背景

Reflection Mind 是 PaperMind 的「AI 学习反思助手」（/reflection 专用页选择 3/7/30 天窗口 → 服务端并行采集 4 类数据 → LLM 流式生成 4 维度报告 → 正则解析存 reflections 表 → 详情页 4 色 Section 卡片 + Q&A 活跃度折线图 + 摘要统计）。经逐文件核查，**主链路（/reflection 页 → /generate-reflection → 解析落库 → 详情页）已完整落地**，UI 还原度高（4 色卡片、bezier 折线图、提问总数/活跃天数、生成时间戳齐全）。但**两条上游数据管道均有断裂点，导致「数据驱动」名存实亡**：`problem_solving_logs` 的写入因迁移缺列必然失败、`paper_problem_logs` 的写入不落 user_id 且无客户端入口，反思采集到的用户数据大概率恒空，详情页统计恒为 0。此外 AI 聊天 `reflection_mind` 入口在 App 内不可达，聊天路径生成不采集数据、不落库。

## 一、实现现状表（对照规格 2.1-2.4）

| # | 规格条目 | 状态 | 证据（文件:行号） |
|---|---|---|---|
| 2.1-1 | 专用反思页 `/reflection`，3/7/30 天时间窗口 | ✅ | `client/screens/reflection/index.tsx:19-23`（TIME_OPTIONS 3days/7days/30days）、`:52-89`（生成按钮 → SSE）；路由 `client/app/reflection.tsx` + `client/app/_layout.tsx:59`；入口 `client/screens/profile/index.tsx:96` |
| 2.1-2 | AI 聊天 `reflection_mind` 入口（「生成学习反思报告」按钮） | ❌ | 界面代码存在：`client/screens/ai-chat/index.tsx:16,35,152-160`；服务端分支存在：`server/src/routes/ai.ts:41-43`。但：①全 App 无任何导航带 `agent='reflection_mind'`（唯一 `push('/ai-chat')` 在 `client/screens/problem-solving-logs/index.tsx:166`，未传 agent → 默认 note_helper），入口不可达；②即便触发，`/ai/chat` 走 `buildReflectionPrompt(context)` 未传 period、客户端未传 context → 不采集任何用户数据、无时间窗口、结果不解析不落库 |
| 2.2-1 | 采集 `paper_problem_logs` 最近 20 条 | ⚠️ | 查询侧 ✅：`server/src/routes/ai.ts:910-918`（limit 20 + user_id + gte(created_at)）。数据源 ❌：写入端 `server/src/routes/problem-logs.ts:23-43` POST 不写 `user_id`（列恒 NULL，表定义 `000_init.sql:112-120`），采集按 `eq('user_id')` 永远匹配不到；且 `api.createProblemLog`（`client/utils/api.ts:160`）全客户端无页面调用 → 该表基本恒空 |
| 2.2-2 | 采集 `problem_solving_logs` 最近 30 条 | ⚠️ | 查询侧 ✅：`server/src/routes/ai.ts:921-929`（limit 30 + user_id + gte(created_at)）。数据源 ❌：写入端 `server/src/routes/problem-solving-logs.ts:31-42` insert 含 `related_draft_ids`（:38），两处迁移建表均无此列（`000_init.sql:127-136`、`000_init_missing_tables.sql:75-84`），PostgREST 报「column not found」→ 插入必失败 → 表恒空，连带 stats 端点恒 0 |
| 2.2-3 | 采集 `reflections` 最近 5 份（避免重复建议） | ⚠️ | 喂给 LLM ✅：`server/src/routes/ai.ts:932-938`（limit 5）。但 ①未按时间窗口过滤（规格写明「均按时间窗口过滤 created_at」）；②System Prompt（`ai.ts:956-979`）只把往期反思作为上下文，**没有显式要求「避免与往期建议重复」** |
| 2.2-4 | 采集 `knowledge_nodes` 最近 50 个 | ✅ | `server/src/routes/ai.ts:941-949`（limit 50 + user_id + gte(created_at)）；表含 user_id 列（`000_init.sql:11-25`） |
| 2.2-5 | 服务端**并行**采集 4 类数据 | ❌ | `server/src/routes/ai.ts:908-950` 四段顺序 `await`，未用 `Promise.all` |
| 2.3-1 | System Prompt 4 维度（各 200-400 字） | ✅ | `server/src/routes/ai.ts:956-979`（## 学习行为/攻克问题/思维模式/学习建议，200-400 字，禁止前言结语） |
| 2.3-2 | LLM 流式生成 | ✅ | `server/src/routes/ai.ts:1043-1057`（anthropic.messages.stream → SSE content 事件） |
| 2.3-3 | 正则解析 4 字段 | ✅ | `server/src/routes/ai.ts:1008`：`/##\s+(学习行为\|攻克问题\|思维模式\|学习建议)\s*\n([\s\S]*?)(?=\n##\s\|\n*$)/g`，与规格正则同构（标题枚举化） |
| 2.3-4 | 4 字段存入 reflections 表 | ✅ | 保存：`server/src/routes/ai.ts:1063-1074`；表结构：`000_init.sql:141-152`（learning_behavior/challenge_report/thinking_pattern/suggestion/period/created_at） |
| 2.3-5 | 解析失败兜底 | ❌ | 无兜底：解析为空 → 字段 null 落库（`ai.ts:1066-1069`）；原始全文不保留、不重试、客户端无失败提示（`client/screens/reflection/index.tsx:80-84` 仅打印 console） |
| 2.4-1 | 4 张 Section 卡片颜色（紫/绿/粉/黄） | ✅ | `client/screens/reflection-detail/index.tsx:84-89`（#6C63FF / #00B894 / #FF6B9D / #FDCB6E） |
| 2.4-2 | Q&A 活跃度折线图（react-native-chart-kit LineChart bezier） | ✅ | `client/screens/reflection-detail/index.tsx:5,218-234`（`bezier`、fromZero、30 天窗口补零见 :33-43） |
| 2.4-3 | 摘要统计：提问总数 + 活跃天数 | ⚠️ | UI ✅：`reflection-detail/index.tsx:91-92,205-214`。数据 ⚠️：取 `/problem-solving-logs/stats`（`:60` → `api.ts:316-317`，服务端 `problem-solving-logs.ts:52-79`）按「当前时间 − days」计算，**不锚定报告 created_at** → 历史报告查看时统计/图表与生成时数据漂移；且受 2.2-2 断裂影响恒 0 |
| 2.4-4 | 系统生成时间戳 | ✅ | `client/screens/reflection-detail/index.tsx:247-249`（「系统生成于」+ created_at） |
| 附 | debug/full-app-test.html 反思模拟 | ⚠️ | 模态生成 ✅：`debug/full-app-test.html:1765-1831`（3/7/30 选择 + `/ai/generate-reflection` SSE + 保存提示）；聊天入口 ⚠️：`:1660-1683`（/ai/chat 无 period）；详情 ⚠️：`:1832-1840` 仅渲染 learning_behavior，无 4 维度/图表 |

## 二、缺口清单（按优先级，每条可独立验收）

### P0 — 数据管道断裂，反思「数据驱动」失效

1. **`problem_solving_logs` 写入必然失败（迁移缺列）**。`server/src/routes/problem-solving-logs.ts:38` insert 含 `related_draft_ids`，但 `000_init.sql:127-136` 与 `000_init_missing_tables.sql:75-84` 建表均无此列 → PostgREST 报错 →「我明白了！记录到问题日志」闭环（规格 1.6）失效。连锁影响：2.2 数据源 #2（问答日志 30 条）恒空、2.4 折线图/提问总数/活跃天数恒 0。修复：新增迁移补列（或路由删字段），二选一即可。
2. **AI 聊天 `reflection_mind` 入口不可达且聊天路径不采集、不落库**。①全 App 无导航传 `agent='reflection_mind'`（`client/screens/problem-solving-logs/index.tsx:166` 是唯一 `push('/ai-chat')` 且无参数）；②即使通过 debug 页触发 `/ai/chat`，服务端 `buildReflectionPrompt(context)`（`ai.ts:41-43`）拿不到 userId/period → 零数据生成、无时间窗口、不解析不保存 reflections。修复：补导航入口（如 profile「学习反思」区或 home），并让聊天入口复用 `/generate-reflection`（推荐）或给 `/chat` reflection_mind 分支补 `context.{userId,period}` + 解析落库。

### P1 — 影响采集完整性与报告可信度

3. **`paper_problem_logs` 写入不落 `user_id` 且无客户端录入页**。`server/src/routes/problem-logs.ts:28-38` POST 只写 problem/process/solution/knowledge_node_ids → user_id 恒 NULL，采集侧 `eq('user_id', ...)`（`ai.ts:913`）永远匹配不到；`api.getProblemLogs/createProblemLog`（`api.ts:159-166`）全客户端无引用（无 problem-logs 页面）。修复：POST 补 `user_id: (req as any).userId`，并补客户端录入页面（或至少在 problem-solving-logs 页复用该表）。
4. **4 维度解析失败无兜底**。`parseReflectionSections`（`ai.ts:987-1020`）返回空字段时直接 null 落库（`ai.ts:1066-1069`），原始全文不保留、不重试，客户端无感知（生成页 onError 只在网络错误时触发）。修复：保存原文到新列（如 `raw_text`）或解析失败时重试一次/降级存全文，并向客户端下发 warning。
5. **详情页统计窗口不锚定报告时间**。`reflection-detail/index.tsx:58-62` 用「当前时间 − period 天数」请求 stats（`problem-solving-logs.ts:52-79`），查看 3 天窗的历史报告时图表展示的是最近 3 天数据而非报告当时窗口。修复：stats 端点支持 `endDate`（传 reflection.created_at），图表按报告窗口计算。
6. **服务端未并行采集**。规格 2.2 明确「并行采集 4 类数据」，实现为顺序 await（`ai.ts:908-950`），4 次 Supabase 往返串行拖慢生成首字延迟。修复：改为 `Promise.all`。

### P2 — 细节与工程

7. **「避免重复建议」只做了一半**。往期反思（limit 5）虽喂给 LLM（`ai.ts:932-938`），但 ①未按时间窗口过滤（与规格「均按时间窗口过滤」不符）；②prompt（`ai.ts:956-979`）未要求模型「避免与往期建议重复」。修复：补一句指令即可。
8. **`reflections` GET `/:id` 无用户隔离**。`server/src/routes/reflections.ts:25-38` 只按 id 查；配合迁移里全放行 RLS 策略（`000_init.sql:236,257-260`「Allow all」），任意用户可读任意反思。修复：按 GET `/` 的方式补 `eq('user_id')`。
9. **详情页细节**：header 显示原始 period 字符串（如「3days」，`reflection-detail/index.tsx:139`）而非「近三天」；30 天图表 30 个日期标签全量渲染（`:95-99` 注释声称「每 N 个显示一个」但未实现），拥挤。生成页错误处理仅 console（`reflection/index.tsx:80-84`），无 toast。
10. **debug 页 reflection 详情模拟不完整**。`full-app-test.html:1832-1840` 只渲染 learning_behavior，无 4 维度卡片、无折线图/摘要统计，与 App 详情页不一致，不便回归测试。

## 三、建议子任务

- [ ] **Task 1：修复 problem_solving_logs 写入断裂** — 新增迁移 `ALTER TABLE problem_solving_logs ADD COLUMN IF NOT EXISTS related_draft_ids JSONB DEFAULT '[]'::jsonb;`（或删除 `server/src/routes/problem-solving-logs.ts:28,38` 的字段）。涉及：`server/migrations/`（新迁移）、`server/src/routes/problem-solving-logs.ts`。
- [ ] **Task 2：打通 AI 聊天 reflection_mind 入口** — 补导航（profile/学习反思区或 home 加「反思助手」入口，`router.push('/ai-chat', { agent: 'reflection_mind' })`）；聊天页「生成学习反思报告」按钮改为调 `/api/v1/ai/generate-reflection`（带 period 选择）并跳转详情页，或服务端 `/chat` reflection_mind 分支支持 `context.{userId,period}` 并解析落库。涉及：`client/screens/profile/index.tsx`（或 home）、`client/screens/ai-chat/index.tsx:99-102,152-160`、`server/src/routes/ai.ts:41-43,895-980`。
- [ ] **Task 3：paper_problem_logs 数据管道修复 + 录入页** — POST 补 `user_id`；补客户端 problem-logs 列表/录入页（或并入 problem-solving-logs 页）。涉及：`server/src/routes/problem-logs.ts:23-43`、`client/utils/api.ts:159-166`、新页面 + `client/app/_layout.tsx`。
- [ ] **Task 4：解析失败兜底** — reflections 表加 `raw_text` 列（迁移），解析为空时存全文并在响应下发 `warning`；前端 toast 提示「部分维度解析失败」。涉及：`server/src/routes/ai.ts:987-1074`、`server/migrations/`、`client/screens/reflection/index.tsx:52-89`、`client/utils/api.ts:500-560`。
- [ ] **Task 5：统计窗口锚定报告时间** — stats 端点支持 `endDate` 参数；详情页以 `reflection.created_at` 为锚点请求。涉及：`server/src/routes/problem-solving-logs.ts:52-79`、`client/utils/api.ts:316-317`、`client/screens/reflection-detail/index.tsx:58-62`。
- [ ] **Task 6：并行采集 + prompt 补「避免重复建议」** — `buildReflectionPrompt` 内 4 类查询改 `Promise.all`；reflections 查询补时间窗过滤；prompt 增加「结合往期反思，避免给出重复建议」。涉及：`server/src/routes/ai.ts:902-979`。
- [ ] **Task 7：安全与细节** — `reflections` GET `/:id` 补 user_id 过滤；详情页 period 显示中文标签、30 天图表标签抽稀、生成失败 toast。涉及：`server/src/routes/reflections.ts:25-38`、`client/screens/reflection-detail/index.tsx:95-99,139`、`client/screens/reflection/index.tsx`。
- [ ] **Task 8（可选）：debug 页 reflection 详情补全** — 渲染 4 维度 + 折线图/统计，与 App 详情页对齐。涉及：`debug/full-app-test.html:1832-1840`。

## 四、验收标准

- 「我明白了！」后 `problem_solving_logs` 能正常插入；生成 7 天反思报告后详情页折线图、提问总数、活跃天数非 0（Task 1）。
- App 内可从 profile/home 进入反思助手聊天，点击「生成学习反思报告」产出基于真实数据的报告并可在历史列表/详情页查看（Task 2）。
- `paper_problem_logs` 有录入入口，写入后带正确 user_id，反思采集「问题解决记录」非空（Task 3）。
- LLM 输出偏离 4 维度格式时，不丢失内容：raw_text 保留、客户端有提示（Task 4）。
- 查看任意历史反思，折线图/统计反映的是该报告生成时的时间窗口（Task 5）。
- 4 类数据并行采集（网络面板可见 4 个并发请求）；连续生成两份报告，第二份建议与第一份无明显重复（Task 6）。
- 未登录用户无法通过 id 读取他人反思；详情页显示「近三天」等中文标签，30 天图表标签不拥挤（Task 7）。
- 既有能力回归通过：/reflection 页 3/7/30 窗口生成、流式展示、4 色卡片、时间戳、历史列表、debug 页全流程。
