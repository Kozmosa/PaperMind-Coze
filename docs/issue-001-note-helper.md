# 对照 PRD 盘点 Note Helper 实现缺口

> 状态：已创建为 GitHub issue #4（https://github.com/Kozmosa/PaperMind-Coze/issues/4），2026-09-02。
> 盘点日期：2026-09-02。PRD 依据：`project_note_helper_spec.md`（Note Helper 完整产品方案，6 大模块 + 交付文件清单 + 验收标准）。

## 背景

Note Helper 是 PaperMind 的「AI 笔记生成与编辑助手」（多文件选择 → 流式生成 → 全屏编辑 → 引用溯源 → 修正与偏好学习）。经逐文件盘点，**主体链路已基本实现**（前端 5 组件 + 全屏页 + 两处多选入口，后端 SSE 生成/修正接口 + 偏好表均已落地，debug/full-app-test.html 已有完整模拟）。剩余缺口集中在 **PDF 页码跳转、PPT 预览、修正后引用同步、偏好提取深度、动画** 等细节，与 PRD 验收标准尚有差距。

## 一、依赖盘点

### 1.1 PRD 点名库（重点）

| 库 | 版本 | 已安装 | 被哪些文件使用 |
|---|---|---|---|
| `@kishannareshpal/expo-pdf` | — | ❌ 未安装 | 全仓库无引用。PDF 目前用 `react-native-webview`（原生）/ `<iframe>`（web）整篇预览，**无法跳页** |
| `react-native-markdown-display` | — | ❌ 未安装 | 全仓库无引用。笔记渲染用自研 `client/components/markdown/MarkdownRenderer.tsx`（WebView + CDN marked/KaTeX） |
| `react-native-reanimated` | ~4.1.1 | ✅ | `client/heroui/**`（大量动画）、`client/screens/knowledge/index.tsx`（手势动画）。**Note Helper 的侧边栏/浮动卡片未使用**（直接条件渲染，无滑入滑出） |
| `react-native-gesture-handler` | ~2.28.0 | ✅ | `client/components/layout/Provider.tsx`、`client/screens/knowledge/index.tsx`、`client/screens/study-note-edit/index.tsx` 等 |
| `expo` | 54.0.33 | ✅ | Expo SDK 54（RN 0.81.5 / React 19.1.0） |
| AI SDK | — | ✅ | 服务端 `@anthropic-ai/sdk ^0.39.0`（`server/src/config/ai.ts`，Anthropic 兼容网关；工作区未提交改动正切换到 DeepSeek 官方）；`openai ^6.9.0` 已装但**服务端源码无任何引用**（冗余） |

### 1.2 其他与 Note Helper 相关的库

| 库 | 版本 | 使用情况 |
|---|---|---|
| `react-native-webview` | 13.15.0 | MarkdownRenderer、NoteHelperSidebar PDF 预览、ReferenceCard |
| `react-native-sse` | ^1.2.1 | `client/screens/ai-chat/index.tsx`；Note Helper 的 SSE 是 `client/utils/api.ts` 手写 XMLHttpRequest 实现（两套并存） |
| `@gorhom/bottom-sheet` | ^5.2.8 | `client/heroui` 组件库内部 |
| `@supabase/supabase-js` | 2.95.3 | 服务端各路由 + 客户端 api.ts |
| `drizzle-orm` / `drizzle-kit` | ^0.45.1 / ^0.31.8 | `server/src/storage/database/shared/schema.ts`；实际迁移用裸 SQL 文件（`server/migrations/`） |
| `pdf-parse` / `mammoth` | ^2.4.5 / ^1.12.0 | `server/src/utils/extract-text.ts` 文本提取 |

### 1.3 完整依赖清单

**client/ dependencies**（50 项，节选与 Note Helper 相关的已在上表；完整列表）：
`@expo/metro-runtime ~6.1.2`、`@expo/vector-icons ^15.0.3`、`@gorhom/bottom-sheet ^5.2.8`、`@react-native-async-storage/async-storage 2.2.0`、`@react-native-community/datetimepicker 8.4.4`、`@react-native-community/slider 5.0.1`、`@react-native-masked-view/masked-view 0.3.2`、`@react-native-picker/picker 2.11.1`、`@react-navigation/bottom-tabs ^7.2.0`、`@react-navigation/native ^7.0.14`、`@supabase/supabase-js 2.95.3`、`dayjs ^1.11.20`、`expo 54.0.33`、`expo-auth-session ~7.0.10`、`expo-av ~16.0.8`、`expo-blur ~15.0.8`、`expo-camera ~17.0.10`、`expo-constants ~18.0.13`、`expo-crypto ~15.0.8`、`expo-document-picker ~14.0.8`、`expo-file-system ~19.0.21`、`expo-font ~14.0.11`、`expo-haptics ~15.0.8`、`expo-image ~3.0.11`、`expo-image-picker ~17.0.10`、`expo-linear-gradient ~15.0.8`、`expo-linking ~8.0.11`、`expo-location ~19.0.8`、`expo-router ~6.0.23`、`expo-splash-screen ~31.0.13`、`expo-status-bar ~3.0.9`、`expo-symbols ~1.0.8`、`expo-system-ui ~6.0.9`、`expo-web-browser ~15.0.10`、`js-base64 ^3.7.7`、`react 19.1.0`、`react-dom 19.1.0`、`react-native 0.81.5`、`react-native-chart-kit ^6.12.0`、`react-native-draggable-flatlist ^4.0.1`、`react-native-gesture-handler ~2.28.0`、`react-native-keyboard-aware-scroll-view ^0.9.5`、`react-native-modal-datetime-picker 18.0.0`、`react-native-reanimated ~4.1.1`、`react-native-safe-area-context ~5.6.0`、`react-native-screens ~4.16.0`、`react-native-sse ^1.2.1`、`react-native-svg 15.12.1`、`react-native-toast-message ^2.3.3`、`react-native-web ~0.21.0`、`react-native-webview 13.15.0`、`react-native-worklets 0.5.1`、`tailwind-merge ^3.4.0`、`tailwind-variants ^3.2.2`、`zod ^4.2.1`

**client/ devDependencies**：`@babel/core ^7.25.2`、`@eslint/js ^9.27.0`、`@types/jest ^29.5.12`、`@types/react ~19.1.0`、`@types/react-test-renderer 19.1.0`、`axios ^1.13.6`、`babel-plugin-module-resolver ^5.0.2`、`babel-preset-expo ^54.0.9`、`chalk ^4.1.2`、`connect ^3.7.0`、`depcheck ^1.4.7`、`esbuild 0.27.2`、`eslint ^9.39.2`、`eslint-formatter-compact ^9.0.1`、`eslint-import-resolver-typescript ^4.4.4`、`eslint-plugin-import ^2.32.0`、`eslint-plugin-react ^7.37.5`、`eslint-plugin-react-hooks ^7.0.1`、`eslint-plugin-regexp ^2.10.0`、`globals ^16.1.0`、`http-proxy-middleware ^3.0.5`、`jest ^29.2.1`、`jest-expo ~54.0.17`、`react-test-renderer 19.1.0`、`tailwindcss ^4.1.18`、`tsx ^4.21.0`、`typescript ^5.8.3`、`typescript-eslint ^8.32.1`、`uniwind ^1.2.7`

**server/ dependencies**：`@anthropic-ai/sdk ^0.39.0`、`@huggingface/transformers ^4.2.0`（本地 BGE 嵌入）、`@supabase/supabase-js 2.95.3`、`@types/pdf-parse ^1.1.5`、`adm-zip ^0.5.17`、`cors ^2.8.5`、`coze-coding-dev-sdk ^0.7.24`、`dayjs ^1.11.20`、`dotenv ^17.2.3`、`drizzle-orm ^0.45.1`、`drizzle-zod ^0.8.3`、`express ^4.22.1`、`mammoth ^1.12.0`、`multer ^2.0.2`、`openai ^6.9.0`（未使用）、`pdf-parse ^2.4.5`、`pg ^8.16.3`、`zod ^4.2.1`

**server/ devDependencies**：`@types/cors ^2.8.19`、`@types/express ^5.0.6`、`@types/multer ^2.0.0`、`@types/pg ^8.16.0`、`drizzle-kit ^0.31.8`、`esbuild 0.27.2`、`tsx ^4.21.0`、`typescript ^5.8.3`

**根 package.json**：dependencies `adm-zip ^0.5.17`、`xml2js ^0.6.2`；devDependencies `@supabase/supabase-js 2.95.3`、`@types/adm-zip ^0.5.8`、`@types/xml2js ^0.4.14`、`dotenv ^17.2.3`、`pdf-parse ^2.4.5`。pnpm workspace（pnpm@9.0.0）。

## 二、功能实现现状（对照 PRD 交付文件清单 + 验收标准）

| # | PRD 条目 | 状态 | 证据 |
|---|---|---|---|
| F1 | `components/NoteHelperFab.tsx` 魔法笔 FAB | ✅ 已实现 | `client/components/note-helper/NoteHelperFab.tsx`；挂载于详情页 `study-note-edit/index.tsx:838`、`material-edit/index.tsx:359` |
| F2 | `components/NoteHelperPanel.tsx` 下半平面（50% 高、生成中/已生成状态、流式渲染、全屏按钮） | ✅ 已实现 | `client/components/note-helper/NoteHelperPanel.tsx`；挂载于 study-note-edit、material-edit、control-center（:837）、knowledge（:651） |
| F3 | `screens/note-helper-fullscreen.tsx` 全屏页（☰ 侧边栏、5 个快捷修正键、自由输入、保存） | ✅ 已实现 | `client/screens/note-helper-fullscreen/index.tsx` + 路由 `client/app/note-helper-fullscreen.tsx` + `_layout.tsx:57` 注册 |
| F4 | `components/NoteHelperSidebar.tsx`（85% 宽、文件列表含类型/日期/引用数、点击预览原文） | ✅ 已实现（缺动画、PDF 不可翻页） | `client/components/note-helper/NoteHelperSidebar.tsx`；预览：纪要显示 blocks 文本，材料优先 viewUrl（WebView/iframe 整篇预览） |
| F5 | `components/ReferenceCard.tsx` 浮动引用卡片 | ✅ 已实现（缺页码跳转） | `client/components/common/ReferenceCard.tsx`（PRD 写 components/ 根，实际在 common/）；含来源头、页码 badge、highlightText、PDF 预览 |
| F6 | control-center 多选模式 | ✅ 已实现 | `client/screens/control-center/index.tsx`：selectedIds + 长按多选（:829 提示） + 「已选 N 个」（:788） + 「生成笔记」按钮（:805） |
| F7 | knowledge 多选模式 | ✅ 已实现 | `client/screens/knowledge/index.tsx`：selectMode + onLongPress 进入多选（:489-491）+「已选 N 个」（:640）+「生成笔记」（:643-645） |
| F8 | `utils/api.ts` 新增 generateNote / refineNote / getFileContent | ✅ 已实现 | `client/utils/api.ts`：`generateNote`（:219，旧版一次性）、`generateNoteStream`（:360）、`refineNoteStream`（:421）、`getSourceFileContent`（:486） |
| B1 | `routes/ai.ts` 新增 POST `/api/v1/ai/generate-note`（流式）+ `/refine-note`（流式） | ✅ 已实现 | `server/src/routes/ai.ts:1158-1329`（SSE、读 papernote_style 偏好、文件级 citations + highlightText 上下文提取）、`:1336-1478`（SSE、修正时提取偏好存表） |
| B2 | `routes/study-notes.ts` GET `/:id` 返回完整 blocks | ✅ 已实现 | `server/src/routes/study-notes.ts:9-23`（`select('*')` 返回整行含 blocks） |
| B3 | `routes/materials.ts` GET `/:id/file-content` 返回内容和页数 | ✅ 已实现 | `server/src/routes/materials.ts:97-210`（返回 pages[]、totalPages、viewUrl、fileType） |
| B4 | `routes/papernote-style.ts` 偏好管理 GET/POST/PATCH | ✅ 已实现（等价覆盖） | `server/src/routes/papernote-style.ts`：GET /、PUT /、POST /extract（关键词提取合并）；挂载于 `server/src/index.ts:49` |
| D1 | `papernote_style` 表 | ✅ 已建 | `server/src/storage/database/shared/schema.ts:91`、`migrations/000_init.sql:99`、未提交的 `migrations/000_init_missing_tables.sql:51`。实际字段：id serial PK + user_id varchar(36) unique + `general_preference` text + `subject_preferences` jsonb（PRD 为 user_id UUID PK + preferences jsonb，实现更细分、功能等价） |
| T1 | 从详情页 FAB 唤醒（默认选中当前笔记） | ✅ | study-note-edit/material-edit 的 FAB + Panel 以当前 id 作为 sourceFiles |
| T2 | 列表页多选唤醒（长按多选 → 底部「生成笔记」） | ✅ | control-center + knowledge 均已实现 |
| T3 | 下半平面实时流式渲染 + 全屏跳转 | ✅ | Panel 通过 `generateNoteStream`（XHR SSE）流式追加，done 后跳 `/note-helper-fullscreen` |
| T4 | 全屏页 ☰ 打开侧边栏，查看源文件，点击可预览原文 | ✅（PDF 仅整篇预览） | Sidebar 文件列表 + 预览已实现；PDF 用 WebView/iframe，**不可翻页/跳页** |
| T5 | 紫色引用标记 + 浮动卡片 + **PDF 直接跳转到对应页码** | ⚠️ 部分实现 | 标记 `[来源:N]` 渲染为紫色 `[N]` 可点击（fullscreen:158-169）、卡片弹出已实现；**页码跳转未实现**（ReferenceCard 只有「第N页」badge，PDF 从第 1 页开始） |
| T6 | 快捷修正键 + 自由输入修正生效 | ✅ | fullscreen QUICK_ACTIONS ×5 + 自由输入 → `refineNoteStream` |
| T7 | 修正指令被提取为偏好 | ⚠️ 部分实现 | refine-note 内 6 条关键词规则提取（详细/简洁/表格/例子/重点/通俗）存 `subject_preferences`；**非 PRD 所述「结构化偏好」深度，未按学科分层** |
| T8 | 保存后写入 `study_notes`，可作为普通学习纪要查看 | ✅ | fullscreen `handleSave` → `api.createStudyNote`（title 为「源文件标题 + 综合笔记」） |
| T9 | 偏好下次生成自动应用 | ✅ | generate-note 读 papernote_style 拼入 system prompt（ai.ts:1171-1184） |
| T10 | 用户手动设置笔记风格 | ✅（PRD 外但 DESIGN.md 要求） | `client/screens/profile/index.tsx`「笔记风格偏好」编辑 general_preference；debug 页也有 style modal + style memo |
| T11 | debug/full-app-test.html 测试载体 | ✅ | 3831 行，5 个 tab（主页/知识/AI/社区/我的）；已模拟 Note Helper 全流程（下半平面 `nh-panel`、全屏、侧边栏、引用卡片、快捷修正、自由输入、风格偏好、保存）、AI 对话、反思报告、文件上传、知识图谱 |

> 补充：仓库内无独立 PRD 文档（glob `*PRD*`/`*需求*` 无命中）；架构文档 `docs/PaperMind-Architecture.md` 覆盖 Tutor/Reflection 两大工作流（均已实现：三层检索、5 色引用卡片、反思报告 4 维度、问题日志闭环——证据 `server/src/routes/ai.ts` `/tutor`、`/generate-reflection` 及对应页面），与 Note Helper 无直接交集。

## 三、缺口清单（按优先级，每条可独立验收）

### P0 — 阻断验收标准

1. **PDF 页码跳转未实现**。PRD 技术约束明确要求 `@kishannareshpal/expo-pdf` + `initialPage`（需 `expo prebuild`）。当前引用卡片和侧边栏都用 WebView/iframe 整篇加载 PDF，用户无法从「第 N 页」引用直接定位。库未安装，也意味着尚未做 prebuild 原生配置。
2. **引用数据链路缺 pageNumber**。`generate-note` 返回的 citations 只有 `{index, sourceId, sourceType, fileName, highlightText}`（ai.ts:1188-1315），`pageNumber` 从未填充；前端 Citation 类型虽有该字段（ReferenceCard.tsx:24），即使换了 PDF 库也无页码可跳。需要后端在提取 highlightText 时按页匹配页码（materials 已有分页数据 `pages[]`）。

### P1 — 影响体验闭环

3. **PPT/其他二进制格式预览未降级**。ReferenceCard 对 `material`/`file_content` 一律走 `PDFViewer`（WebView 直接加载 .ppt/.pptx），侧边栏同样；PRD 要求「降级显示提取的文本内容，或提示开发中」。`materials/:id/file-content` 已返回 `pages[].text`，前端未按 fileType 分流。
4. **修正后 citations 不同步**。`refine-note` 只流式返回正文，不返回新的引用映射；若修正删改 `[来源:N]` 标记，全屏页 citations 列表与正文脱节，引用卡片可能指向错误源文件。PRD 要求「每次修正基于当前笔记增量修改」并保留引用有效性。
5. **偏好提取深度不足**。当前是 6 条关键词 if/else（ai.ts:1361-1368 与 papernote-style.ts:90-98 重复实现），PRD 要求「转化为结构化偏好」；且 `subject_preferences` 未按学科（L1 标签）分层，跨学科偏好会互相污染。可考虑用 LLM 提取。

### P2 — 工程与打磨

6. **侧边栏/浮动卡片无动画**。PRD 指定 reanimated 滑入滑出 + gesture-handler；当前是直接条件渲染（`visible ? <View/> : null`），reanimated 虽已安装但 Note Helper 组件未使用。
7. **MarkdownRenderer 依赖 jsdelivr CDN**（marked + KaTeX），离线/内网环境笔记渲染失效；PRD 点名 `react-native-markdown-display` 未采用（自研方案可保留，但需评估本地打包资源或接受风险）。
8. **工作区有未提交改动需先处理**（提交前必须先评审，避免污染基线）：
   - `server/src/config/ai.ts`：切换至 DeepSeek 官方 Anthropic 兼容接口；~~含硬编码 key~~ **已解决**（2026-09-02 已将 key 移入 `server/.env`，环境变量读取 + fail-fast 校验）；遗留：git 历史（HEAD）中仍有旧 Anthropic key `sk-accc8...`，建议吊销或 filter-repo 清除；
   - `server/src/routes/knowledge-builder.ts`：PDF 视觉模型抽取兜底（三重门校验 + 拒答安全网）；
   - `server/src/routes/upload.ts`：中文文件名 latin1→utf8 修复 + 上传后同步分类；
   - `server/src/utils/extract-text.ts`：新增 `extractPdfWithVision`、`isRefusalOrPlaceholderText` 等（+113 行）；
   - `debug/full-app-test.html`：调试页大改（+176/-65）；
   - 新文件 `server/migrations/000_init_missing_tables.sql`（与 000_init.sql 部分重复建表，IF NOT EXISTS 安全，需决定保留）；
   - 未跟踪调试产物 `debug/m*.json`、`debug/proc2.json`、`debug/rep*.json` 等 10 个文件（建议清理或加入 .gitignore）。
9. **冗余依赖与代码**：`openai ^6.9.0` 已装但服务端零引用，可移除；旧组件 `client/components/note-helper/NoteHelper.tsx`（「节点笔记」便签面板）与 PRD 功能无关但同名易混淆，建议改名或迁移；SSE 客户端两套并存（react-native-sse 用于 ai-chat，手写 XHR 用于 Note Helper），可统一。
10. **debug 页与后端接口不一致**：debug 页 `generateNoteStream` 传 `stylePreferences` 参数（full-app-test.html:2105），服务端 generate-note 不读该参数（只读 papernote_style 表），接口语义需对齐。

## 四、建议拆分的子任务

- [ ] **Task 1：PDF 页码跳转（前端原生化）** — 安装 `@kishannareshpal/expo-pdf`、执行 `expo prebuild`，ReferenceCard 与 Sidebar 的 PDF 预览改用它并支持 `initialPage` 跳转；保留 web 端 iframe 方案。涉及：`client/package.json`、`client/components/common/ReferenceCard.tsx`、`client/components/note-helper/NoteHelperSidebar.tsx`。
- [ ] **Task 2：引用页码数据链路（后端）** — generate-note 为 material 来源填充 `pageNumber`（用 `file_contents`/`materials file-content` 的分页数据匹配 highlightText 所在页），并随 citations 下发；前端 Citation 透传。涉及：`server/src/routes/ai.ts`、`client/utils/api.ts`。
- [ ] **Task 3：PPT/图片等格式预览降级** — 按 `fileType` 分流：PPT → 渲染 `pages[].text` 文本（或提示开发中），图片 → expo-image；仅 PDF 走 PDF 查看器。涉及：`ReferenceCard.tsx`、`NoteHelperSidebar.tsx`。
- [ ] **Task 4：修正后引用同步** — refine-note 输出后重算/过滤 citations（按正文中仍存在的 `[来源:N]` 标记过滤，或让模型返回引用映射），并保证修正流中引用标记不被吞掉。涉及：`server/src/routes/ai.ts`、`client/screens/note-helper-fullscreen/index.tsx`。
- [ ] **Task 5：偏好学习升级** — 用 LLM 从修正指令提取结构化偏好（detail_level、prefer_tables、prefer_examples、emphasize_keypoints、language_style 等），按源文件 L1 标签学科分层写入 `subject_preferences`，替换两处关键词匹配实现；下一次生成按学科注入。涉及：`server/src/routes/ai.ts`、`server/src/routes/papernote-style.ts`。
- [ ] **Task 6：侧边栏/引用卡片动画** — 用已安装的 reanimated 实现侧边栏左滑入出、遮罩淡入、卡片弹性入场（可参考 heroui 动画基建）。涉及：`NoteHelperSidebar.tsx`、`ReferenceCard.tsx`。
- [ ] **Task 7：工作区整理与提交** — 评审 5 个已改文件 + 新迁移文件后分 commit 提交（API key 已移入环境变量，2026-09-02 完成）；清理或忽略 `debug/*.json` 调试产物。涉及：`server/src/config/ai.ts`、`server/src/routes/knowledge-builder.ts`、`server/src/routes/upload.ts`、`server/src/utils/extract-text.ts`、`server/migrations/000_init_missing_tables.sql`、`debug/*.json`。
- [ ] **Task 8（可选）：Markdown 离线渲染** — 将 KaTeX/marked 资源本地化打包，或评估迁移 `react-native-markdown-display`。涉及：`client/components/markdown/MarkdownRenderer.tsx`。

## 五、验收标准（对齐 PRD 第六节）

- 引用卡片点击后，PDF 打开即定位到对应页码（Task 1+2）。
- PPT 源文件在侧边栏/引用卡片中可看到提取的文本内容（Task 3）。
- 任意次修正后，引用标记与引用卡片仍正确指向源文件（Task 4）。
- 修正指令自动积累为偏好，下次生成可感知差异（Task 5）。
- 侧边栏滑入滑出、引用卡片弹出有动画（Task 6）。
- 已实现的既有能力回归通过：详情页 FAB / 列表页多选唤醒、下半平面流式生成、全屏编辑、保存为学习纪要、debug 页全流程。
