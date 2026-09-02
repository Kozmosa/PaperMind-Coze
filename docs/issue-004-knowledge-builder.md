# 盘点 Knowledge Builder 知识构建流程的规格与缺口

> 状态：已创建为 GitHub issue #7（https://github.com/Kozmosa/PaperMind-Coze/issues/7），2026-09-02。盘点日期：2026-09-02。
> 本流程没有独立规格文档（架构文档仅覆盖 Tutor 与 Reflection），以下规格是从代码、README、DESIGN.md、`docs/PaperMind-Architecture.md`、git 提交历史重建的。

## 背景

Knowledge Builder 是 PaperMind 的「AI 知识构建」流程：用户上传学习资料 → AI 自动分类（三层标签 L1 学科 / L2 领域 / L3 章节概念）→ 生成 papercore 摘要 → 写入知识图谱。主体链路已落地（上传、文本提取、LLM 三级分类、图谱聚合、debug 页完整模拟），但存在**重复建记录、失败不可见、图片/.doc 提取空壳、图谱半写入**等缺口。

## 零、重建的规格要点（证据）

1. **三层标签体系**：tags 为 `[L1, L2, L3...]` 数组（按位置推断层级），logical_path 为 `/L1/L2/L3/` 数组；每文档唯一 L1/L2（`docs/PaperMind-Architecture.md:10-11,158`；`knowledge-builder.ts:304`）。
2. **上传格式**：pdf/docx/doc/pptx/ppt/md/txt/csv/xlsx/jpg/jpeg/png/gif/webp，20MB 上限，中文文件名 latin1→utf8 修复（`server/src/routes/upload.ts:12-19,39-63`；提交 8337b94、21f6d57）。
3. **文本提取**：pdf-parse（PDF）、mammoth（DOCX）、adm-zip+正则（PPTX/XLSX）、直读（TXT/MD/CSV）；图片不做 OCR（`server/src/utils/extract-text.ts:28-149`）。
4. **AI 分类流水线**（`server/src/routes/knowledge-builder.ts`）：
   - Step 1 papercore：长文采样（开头 1200 + 中段 800 + 末尾 800）→ LLM 输出 80-150 字摘要（:310-352）；失败回退原文前 150 字。
   - Step 2 全局定位：LLM 读现有 L1→L2 树 + papercore → 输出 `{"L1","L2"}`（:425-478）；已有 L1 存在时必须精确匹配，否则回落第一个已有 L1（:475-478）。
   - Step 3 局部演化：LLM 从 top-8 相关已有 L3 中强制复用（逐字一致），新标签上限按文本长度 3/4/5 个；LLM 输出再经字符重叠 >75% 强制匹配已有 L3 防标签爆炸（:483-567）。
   - 路径构建：每个 L3 一条 `/L1/L2/L3/`（:585-594）；用户上传时指定的 logical_path 优先保留（:600-614, 781-804）。
5. **三重校验 + forced/degraded 兜底**：① 占位/不支持文本检测（:713-715）→ ② `isReadableText` 乱码检测（CJK<3% 且 ASCII<15% 判乱码，:179-199）→ ③ 正常路径；无文本/乱码时按文件名生成降级 papercore 并**仍然强制 LLM 分类**（forced / forced-degraded，:718-766），失败也标记 `ai_processed=true` + `/未分类/`。
6. **写入目标**：materials / study_notes 表更新 tags/papercore/logical_path/ai_processed/viewed_after_process（:807-824）；图谱 `graph-data` 从这两表聚合标签节点 + 力导向布局（:1166-1514）。规格中「写入 knowledge_nodes」仅由手动构建器实现（见缺口 6）。
7. **辅助能力**：TOC 剥离（:140-175）、`/reprocess-material` 重新分析（:846-1005）、`/rebuild-all` 全量重建 + L2 重分配 + 标签合并（:1745-2071）、批次接口 `/process-study-notes`、`/process-materials`（:1010-1161）。
8. **前端**：Expo 客户端上传入口在 control-center（学习纪要/资料两个模态，后台触发分类 + 红点提示）；`knowledge-builder` 屏是「图片→手动建知识节点」交互流（另一条链路）；完整的上传 UI（dropzone + 文件夹选择树 + 进度 + 分类结果）目前只存在于 `debug/full-app-test.html`。
9. **AI 模型**：未提交改动切到 DeepSeek 官方 Anthropic 兼容接口 `deepseek-v4-pro`（`server/src/config/ai.ts:12-27`），作为分类 + papercore 主模型。

## 一、实现现状表

| #   | 规格要点                                            | 状态 | 证据（文件:行号）                                                                                                                                         |
| --- | --------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 文件上传（multer，20MB，14 种格式）                 | ✅   | `server/src/routes/upload.ts:37-63`                                                                                                                       |
| S2  | 中文文件名 latin1→utf8 修复                         | ✅   | `upload.ts:12-19`（未提交）                                                                                                                               |
| S3  | 文本提取 PDF/DOCX/PPTX/XLSX/TXT/MD/CSV              | ✅   | `server/src/utils/extract-text.ts:87-149`                                                                                                                 |
| S4  | 图片 OCR / 视觉提取                                 | ❌   | `extract-text.ts:34-37` 直接返回空文本                                                                                                                    |
| S5  | .doc / .ppt 提取                                    | ❌   | fileFilter 放行（`upload.ts:44-45,57`）但 `extract-text.ts` 无 .doc/.ppt 分支，静默返回空；「旧版PPT」提示文案只存在于死代码 `knowledge-builder.ts:123`   |
| S6  | papercore 生成（80-150 字 + 降级文案）              | ✅   | `knowledge-builder.ts:310-365`                                                                                                                            |
| S7  | L1/L2 全局定位（学科树 + 精确匹配规则）             | ⚠️   | `knowledge-builder.ts:425-478`；L1 守卫强制回落第一个已有 L1，有错分风险                                                                                  |
| S8  | L3 局部演化（强制复用 + 上限 3/4/5 + 字符重叠防爆） | ✅   | `knowledge-builder.ts:415-416, 483-567`                                                                                                                   |
| S9  | 三重校验 + forced/degraded 强制分类                 | ✅   | `knowledge-builder.ts:713-766`                                                                                                                            |
| S10 | 用户指定 logical_path 保留                          | ✅   | `knowledge-builder.ts:600-614, 781-804`（提交 21f6d57）                                                                                                   |
| S11 | 上传后同步分类（不再 fire-and-forget）              | ⚠️   | `upload.ts:120-170`（未提交）；同步阻塞 + 与客户端重复建记录（见缺口 1）                                                                                  |
| S12 | 写入 materials/study_notes                          | ✅   | `knowledge-builder.ts:807-824`                                                                                                                            |
| S13 | 写入 knowledge_nodes（图谱节点自动生成）            | ❌   | 上传流程不写 knowledge_nodes；graph-data 也不读它（:1171-1174），节点只能靠手动构建器逐张建（`client/screens/knowledge-builder/index.tsx:304-338`）       |
| S14 | 图谱聚合 + 标签节点 + 文件夹视图                    | ✅   | `knowledge-builder.ts:1166-1514`；`client/screens/knowledge/index.tsx:135-232`                                                                            |
| S15 | 分类失败的用户反馈                                  | ❌   | 主路径 LLM 出错仍写 `ai_processed=true`（tags 可为空）；Expo 端 fire-and-forget `catch(()=>{})` 静默吞错（`client/screens/control-center/index.tsx:326`） |
| S16 | 重试 / 重新分析入口                                 | ⚠️   | material 有「重新分析」（`client/screens/material-edit/index.tsx:116-135` → `/reprocess-material`）；study_note 无对应入口                                |
| S17 | 并发上传 / 队列 / 超时                              | ❌   | 无队列、无超时、无并发控制；每次分类约 3 次 LLM + 11 次全表 tags 查询                                                                                     |
| S18 | 前端上传 UX（文件夹选择树、进度、分类结果回显）     | ⚠️   | 仅 debug 页实现（`debug/full-app-test.html:2365-2393, 2464-2555`）；Expo 客户端只有简单文件选择 + 一句「AI 将在后台自动编排」                             |
| S19 | 数据表与迁移一致                                    | ⚠️   | `schema.ts` 缺 materials/study_notes 定义；`000_init_missing_tables.sql`（未提交）与 `000_init.sql` 重复建 12 表且缺 RLS                                  |

## 二、缺口清单（P0/P1/P2，每条可独立验收）

### P0 — 阻断验收

1. **一次上传产生两条 material + 两次分类**。未提交的 `upload.ts:124-139` 在 `/upload` 内部插入 material 并同步分类；但 debug 页（`full-app-test.html:2514-2546`）和 Expo control-center（`client/screens/control-center/index.tsx:294-327`）仍走「uploadFile → POST /materials 再建一条 → 再触发 process-content」。后果：图谱出现重复节点、每文件双倍 LLM 成本（约 6 次调用）。需对齐契约：客户端改用 upload 返回的 `materialId`，或移除 upload 内部的建记录逻辑。
2. **分类失败不可见、不可恢复**。主路径 LLM 任一调用出错时 catch 后仍写 `ai_processed=true`（`knowledge-builder.ts:445-463, 519-566, 807-824`），tags 可为空、路径落 `/未分类/`，之后不会被 `/trigger`（:1574-1597，仅统计）或批量接口重新拾起；Expo 端触发分类的 fetch `catch(()=>{})`（`control-center/index.tsx:253-256, 323-326`）静默吞错，用户只看到「AI 将在后台自动编排」但红点永不出现。缺 `status: failed` 字段 + 重试入口。
3. **同步分类阻塞上传请求**。`upload.ts:120-170` 在 HTTP 响应前完成全部 3 次 LLM 调用 + 约 11 次全表 tags 查询（`getExistingTagHierarchy`/`buildL1L2Tree`/`getTopL3sUnderL2`/`countL3sUnderL2`/`getAllL3NamesUnderL2` 每次 `select tags` 整表无 limit），单文件可耗时数十秒；Expo `api.uploadFile` await 期间上传弹窗挂起，无进度、无超时、并发上传无节流。
4. **图片资料无 OCR/视觉**。fileFilter 允许 jpg/png/gif/webp（`upload.ts:51-54`）但 `extract-text.ts:34-37` 对 `image/*` 直接返回空文本 → 只能按文件名降级分类。唯一视觉能力在手动节点构建流（`server/src/routes/ai.ts:283-359`），且主模型 `deepseek-v4-pro`（`config/ai.ts:19`）的视觉输入支持未验证。ROADMAP 已注明「视觉模型兜底方案已撤回」（`docs/ROADMAP.md:12`），需重新决策。
5. **.doc/.ppt 提取是空壳**。提交 8337b94 声称「add .ppt/.doc support」，实际只放行了文件类型：`extract-text.ts` 无 `.doc`、`.ppt` 分支（`.ppt` 占位文案只存在于死代码 `extractFileContent`，`knowledge-builder.ts:68-134` 无人调用）。上传 .doc/.ppt 会静默得到空文本 → 按文件名降级分类，且 draft_pool 写入误导性占位「[文件内容已提取，共 ? 页]」（`upload.ts:90`）。

### P1 — 影响体验闭环

6. **「写入知识图谱」只实现了一半**。规格重建自架构文档「知识组织：三层标签体系，AI 自动分类」+ 流程描述「写入 knowledge_nodes/materials」；实际资料上传后只写 materials，不生成 knowledge_nodes；`graph-data`（`knowledge-builder.ts:1171-1174`）只聚合 study_notes + materials，knowledge_nodes 与图谱完全割裂（手动建的节点不出现在图谱里）。
7. **标签层级推断准确性风险**。L1 守卫在已有 L1 不匹配时强制回落第一个已有 L1（`knowledge-builder.ts:475-478`）——上传全新学科文档会被错分到已有学科；L2 允许随意新建、无去重校验，靠事后 `consolidate-tags` 补救（:1604-1740）。扫描版 PDF（test_data 中 Bi_ORC 系列）只有 `rebuild-all` 的硬编码「数学 > 运筹学」特殊通道（:1932-1996），单文件上传/process-content 对扫描 PDF 只按文件名分类，无通用方案。
8. **批次接口跨用户处理**。`/process-study-notes`、`/process-materials` 查询不带 `user_id` 过滤（`knowledge-builder.ts:1014-1019, 1082-1087`），auth 中间件对无 token 请求回落 guest（`server/src/middleware/auth.ts`），多用户场景会互相处理对方的记录。
9. **reprocess 与 process 行为不一致**。`/reprocess-material` 的 degraded 分支直接写 `['/未分类/']`（`knowledge-builder.ts:960-968`），不保留用户设置的 logical_path（process-content 会保留，:725-726, 751-752）；且 study_note 没有 reprocess 入口。
10. **分类性能线性恶化**。每个文件的分类要执行约 11 次无 limit 的整表 tags 查询 + 3 次 LLM 调用；`rebuild-all` 为每个文件串行 2-3 次 LLM（:1777-1841）加一次 L2 重分配 LLM（:1858-1928），资料量大时单次重建可能数小时且无进度回报（一次性响应）。

### P2 — 工程与打磨

11. **死代码与撤回遗留**：`extractFileContent`（`knowledge-builder.ts:68-134`）、`safePayload`（:577-579）无人调用；placeholder 检测中的 `需OCR` 字符串（:714）在当前代码里没有任何产生源（视觉兜底撤回后的残留）。
12. **迁移文件与 schema 漂移**：未提交的 `server/migrations/000_init_missing_tables.sql` 与 `000_init.sql` 重复建 12 张表，但缺 study_notes/materials/RLS 策略，注释「补齐缺失表」与内容不符；drizzle `schema.ts` 无 materials/study_notes 定义；三份 SQL（000_init / add_papermind_fields / 000_init_missing_tables）并存需合并取舍。
13. **Expo 客户端上传 UX 不完整**：文件夹选择树、进度条、分类结果展示、失败 toast 只存在于 debug 页（`full-app-test.html:2365-2393, 2464-2555`）；Expo 客户端无分类路径选择、无进度、无分类结果回显、无批量上传。
14. **file_contents 双文本源**：上传时按 `\n\n` 粗切页写入 file_contents 且只挂 draft_id（`upload.ts:102-118`，非真实页码、与 material 无关联）；material 详情另走 `/materials/:id/file-content` 重新提取（`materials.ts:97-210`），两套文本来源易不一致。
15. **降级 papercore 文案失真**：所有不可读文档统一生成「该文档以公式/图表为主，根据文件名及上下文推断…」（`knowledge-builder.ts:358-365`），用户无法区分「真·公式密集型文档」和「提取失败的扫描件」，可能误导学习记录。

## 三、建议子任务

- [ ] **Task 1：消除重复建记录（契约对齐）** — `/upload` 返回 `materialId` + `classification` 后，debug 页与 control-center 直接复用，不再二次 POST /materials + process-content；或移除 upload 内部建 material 逻辑恢复「客户端建记录」单一路径。涉及：`server/src/routes/upload.ts`、`debug/full-app-test.html`（`submitUploadMaterial`）、`client/screens/control-center/index.tsx`。
- [ ] **Task 2：分类失败可见 + 可恢复** — materials/study_notes 增加 `ai_processed` 之外的处理状态（或新增 `process_status` 列），LLM 失败时标记 failed 而非已处理；control-center 触发分类后轮询/回调展示失败并给出「重试」按钮；补 study_note 的 reprocess 端点。涉及：`server/src/routes/knowledge-builder.ts`、`server/src/routes/study-notes.ts`、`client/screens/control-center/index.tsx`、`client/screens/study-note-edit/index.tsx`。
- [ ] **Task 3：上传异步化 + 队列/超时** — 分类从上传请求中解耦（任务队列或轮询式 fire-and-forget + 状态查询），加 LLM 调用超时、并发上限、`getExistingTagHierarchy` 等查询的 limit 与内存缓存。涉及：`server/src/routes/upload.ts`、`server/src/routes/knowledge-builder.ts`。
- [ ] **Task 4：.doc/.ppt/图片提取补齐** — .doc 用 antiword/textract 类方案（或明确拒绝并给提示）；.ppt 复用死代码中的占位提示让用户改存 PPTX；图片资料决策 OCR（如 tesseract.js）或视觉模型，并验证 deepseek-v4-pro 的图片输入支持。涉及：`server/src/utils/extract-text.ts`、`server/src/config/ai.ts`、`server/src/routes/upload.ts`。
- [ ] **Task 5：上传 → 图谱节点打通** — 资料分类完成后可选生成 knowledge_nodes（papercore/tags/short_name 派生），并让 graph-data 聚合 knowledge_nodes（或在图谱页明确分层展示两种节点）。涉及：`server/src/routes/knowledge-builder.ts`、`server/src/routes/knowledge-nodes.ts`、`client/screens/knowledge/index.tsx`。
- [ ] **Task 6：标签准确性加固** — L1 守卫改为「不匹配时保留新 L1（或提示用户确认）」而非强制回落；L2 新建前做字符重叠去重；扫描版 PDF 的文件名分类从 Bi_ORC 硬编码推广为可配置课程映射。涉及：`server/src/routes/knowledge-builder.ts`。
- [ ] **Task 7：批次接口加 user_id 过滤** — `/process-study-notes`、`/process-materials` 补 `.eq('user_id', userId)`，并与 reprocess 的 degraded 路径统一「保留用户 logical_path」逻辑。涉及：`server/src/routes/knowledge-builder.ts`。
- [ ] **Task 8：Expo 上传 UX 对齐 debug 页** — 将文件夹选择树、分类进度、失败 toast 移植为 Expo 组件（可参考 debug 页实现）；material 列表展示分类状态（处理中/已分类/失败）。涉及：`client/screens/control-center/index.tsx`、新增 `client/components/` 上传组件。
- [ ] **Task 9：清理与迁移整理** — 删除 `extractFileContent`/`safePayload` 死代码与 `需OCR` 残留；三份迁移 SQL 合并为一份基线（含 RLS）；schema.ts 补齐 materials/study_notes；debug 页与后端字段语义对齐。涉及：`server/src/routes/knowledge-builder.ts`、`server/migrations/*.sql`、`server/src/storage/database/shared/schema.ts`。

## 四、验收标准

- 一次上传在 materials 表只产生一条记录，图谱无重复节点（Task 1）。
- 分类失败时用户能看到失败状态并能一键重试，重试成功后标签/路径正常写入（Task 2）。
- 上传请求快速返回（<3s），分类在后台完成，红点按现有机制提示（Task 3）。
- .doc/.ppt/图片上传后：要么能提取出可读文本参与分类，要么收到明确格式提示，不再静默降级（Task 4）。
- 已分类资料在知识图谱中可见（节点或文档两态皆可，需与图谱页交互一致）（Task 5）。
- 上传全新学科文档不会被强制归入已有 L1；不同用户的记录互不处理（Task 6/7）。
- Expo 客户端上传流程具备路径选择、进度与失败反馈，与 debug 页能力对齐（Task 8）。
- 既有能力回归通过：forced/degraded 分类、用户 logical_path 保留、中文文件名、图谱/文件夹视图、material-edit 重新分析、debug 页全流程。
