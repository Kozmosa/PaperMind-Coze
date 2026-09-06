# PaperMind 功能路径与完善方向（Roadmap）

> 仓库：https://github.com/Kozmosa/PaperMind-Coze · 更新：2026-09-02
> 相关文档：`docs/PaperMind-Architecture.md`（Tutor & Reflection 架构）、`docs/issue-001-note-helper.md`（Note Helper 缺口盘点）

## 一、功能全景（功能路径）

### 1. 学习资料（Materials）

| 功能     | 状态 | 说明                                                               |
| -------- | ---- | ------------------------------------------------------------------ |
| 文件上传 | ✅   | .pdf/.ppt/.doc 等；中文文件名 latin1→utf8 修复；上传后自动同步分类 |
| 文本提取 | ✅   | pdf-parse + mammoth 单一路径（视觉模型兜底方案已撤回）             |
| 资料详情 | ✅   | material-edit 页 + Note Helper FAB                                 |
| 资料预览 | ⚠️   | PDF 用 WebView/iframe 整篇预览，**不可跳页**；PPT 未做文本降级     |

### 2. 学习纪要（Study Notes）

| 功能        | 状态 | 说明                                                         |
| ----------- | ---- | ------------------------------------------------------------ |
| 纪要编辑    | ✅   | study-note-edit，blocks 结构                                 |
| Note Helper | ⚠️   | 6 大模块已落地，细节缺口见 issue-001（PDF 跳页、引用同步等） |
| 保存为纪要  | ✅   | 生成笔记 → study_notes 表，可作普通纪要查看                  |

### 3. 知识库（Knowledge）

| 功能          | 状态 | 说明                                    |
| ------------- | ---- | --------------------------------------- |
| 知识图谱/节点 | ✅   | knowledge-nodes + 图谱可视化            |
| 多选生成笔记  | ✅   | 长按多选 →「生成笔记」                  |
| 知识构建器    | ✅   | knowledge-builder：上传 → 分类 → 入图谱 |

### 4. AI 学习（Tutor & Reflection）

| 功能     | 状态 | 说明                                                 |
| -------- | ---- | ---------------------------------------------------- |
| AI 对话  | ✅   | Tutor 三层检索（向量 + 图谱 + 全文），真实 AI 已接入 |
| 反思报告 | ✅   | 4 维度 + 5 色引用卡片                                |
| 问题日志 | ✅   | problem-logs / problem-solving-logs 闭环             |

### 5. 社区（Community）

| 功能   | 状态 | 说明                  |
| ------ | ---- | --------------------- |
| 论坛   | ✅   | forums + forum-detail |
| 私聊   | ✅   | chat                  |
| 草稿池 | ✅   | draft-pool            |

### 6. 控制中心 & 个人

| 功能         | 状态 | 说明                              |
| ------------ | ---- | --------------------------------- |
| 控制中心     | ✅   | 汇总 + 多选批量操作               |
| 登录         | ✅   | login                             |
| 笔记风格偏好 | ✅   | profile 编辑 + papernote_style 表 |

### 7. 测试载体

| 载体                     | 状态 | 说明                                           |
| ------------------------ | ---- | ---------------------------------------------- |
| debug/full-app-test.html | ✅   | 390×844 手机框全流程模拟（唯一确认的测试页面） |
| Expo 原生客户端          | ⚠️   | 未 prebuild，未真机验证                        |

## 二、目前功能的完善方向（按优先级）

### P0 — 阻断 PRD 验收

1. **PDF 页码跳转**：安装 `@kishannareshpal/expo-pdf` + `expo prebuild`，引用卡片/侧边栏支持 initialPage 跳转
2. **引用页码数据链路**：generate-note 的 citations 补 `pageNumber`（按 highlightText 匹配 materials 分页数据）

### P1 — 体验闭环

3. **PPT/图片预览降级**：按 fileType 分流（PPT → 提取文本，图片 → expo-image）
4. **修正后引用同步**：refine-note 后重算 citations，保证 `[来源:N]` 与卡片一致
5. **偏好学习升级**：LLM 提取结构化偏好（detail_level、prefer_tables…），按学科分层，替换 6 条关键词规则

### P2 — 工程与打磨

6. **动画**：侧边栏/引用卡片用 reanimated 做滑入滑出（已安装未使用）
7. **Markdown 离线渲染**：KaTeX/marked 本地化，摆脱 jsdelivr CDN
8. **工作区整理提交**：评审 5 个已改后端文件 + 新迁移后分 commit 提交；清理 debug/*.json
9. **冗余清理**：移除零引用的 `openai` 包；统一两套 SSE 实现；`note-helper/NoteHelper.tsx`（便签面板）改名避免混淆
10. **debug 页与后端语义对齐**：stylePreferences 参数等

### 产品层面建议

- **原生体验**：expo prebuild + 真机跑一遍核心流程（当前主要靠 debug 页模拟）
- **测试体系**：目前几乎无自动化测试，至少补后端路由级 smoke test
- **社区深化**：可扩展学习小组/共享笔记（当前仅论坛+私聊）
- **安全**：DeepSeek key 已移入 server/.env（2026-09-02 完成）；git 历史中遗留的旧 Anthropic key（HEAD 的 ai.ts）建议吊销或 filter-repo 清除

## 三、协作流程（roadmap + issue）

1. **敲定 issue**：`docs/issue-001-note-helper.md` 草稿审阅 → 敲定后拆 8 个子任务
2. **认领与完成**：谁有空谁领子任务，完成后 commit + push
3. **回归验证**：debug/full-app-test.html 全流程 + PRD 验收标准
