# PaperMind 技术架构与产品创新分析

## 一、Tutor（智能导师）工作流

### 1.1 服务器启动 — 索引初始化

服务器启动 2 秒后，后台预热触发：

1. **TagVectorStore.buildFromDatabase()** — 从 `knowledge_nodes`、`study_notes`、`materials` 三张表的 `tags` 字段提取所有去重标签
   - 按位置推断层级：index 0 → L1（学科），index 1 → L2（领域），index 2+ → L3（章节/概念）
   - 使用 `Xenova/bge-small-zh-v1.5` 模型对每个标签名做嵌入，存入内存向量库

2. **UnifiedVectorIndex.buildIndex()** — 跨 4 表构建统一向量索引

| 表 | 筛选条件 | 向量化内容 |
|---|---|---|
| `knowledge_nodes` | papercore 非空 | papercore 全文 |
| `study_notes` | ai_processed=true, papercore 非空 | papercore 全文 |
| `materials` | ai_processed=true, papercore 非空 | papercore 全文 |
| `file_contents` | extracted_text 非空（≤500 条） | 前 300 字符 |

### 1.2 用户提问 → 三层检索

```
用户提问
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ Layer 1: 用户指定知识节点？                             │
│   → 精确查库（knowledge_nodes + file_contents）         │
│   → 有结果则跳过 Layer 2、3                              │
├──────────────────────────────────────────────────────┤
│ Layer 2: UnifiedVectorIndex.search(query, topK=10)    │
│                                                        │
│   Step 1 — 向量检索                                     │
│     query 经 BGE-small-zh-v1.5 嵌入 (512维)             │
│     → 与所有索引记录的 papercore 向量做余弦相似度        │
│                                                        │
│   Step 2 — 标签加成 (Tag Boosting)                       │
│     ├─ 语义匹配：query 嵌入 → 搜索 L1/L2 标签嵌入        │
│     │   (阈值：L1=0.25, L2=0.20)                        │
│     └─ 字面匹配：query 字符串直接包含标签名              │
│     → 共享标签越多分数越高（+10%/tag，最高+30%）         │
│                                                        │
│   Step 3 — 过滤排序                                     │
│     score ≥ 0.3 → 降序 → 取 top-10                     │
│     结果跨 4 种类型混合排列                              │
├──────────────────────────────────────────────────────┤
│ Layer 3: 搜索无结果？                                    │
│   → 降级加载：knowledge_nodes (100) + study_notes (50)  │
│               + materials (50)                          │
└──────────────────────────────────────────────────────┘
```

### 1.3 Prompt 组装

检索结果按 `sourceType` 分组回源查库，获取完整字段：

- **knowledge_nodes** → 查 papercore + tags + short_name + attached_draft_ids → 加载关联 file_contents 原文
- **study_notes** → 查 papercore + tags + title + content（截取前 200 字）
- **materials** → 查 papercore + tags + name + file_path
- **file_contents** → 直接使用索引中的 snippet（前 300 字），标注 fileName + pageNumber

组装为 System Prompt，包含：
- 知识图谱上下文（节点 papercore + 标签 + 语义相关度分数）
- 原文片段（文件名 + 页码 + 文本）
- 图片分析指令（如用户上传图片）
- 引用格式要求：`【来源：{名称}】`、`【来源：{文件名}，第N页】`、`「原文...」`

### 1.4 流式响应与引用提取

- 通过 Anthropic 兼容 API 流式生成回答（SSE）
- 流结束后调用 `extractCitations()`，按优先级提取引用：

| 优先级 | 来源 | 类型 |
|---|---|---|
| 1 | 用户上传图片 | `image` |
| 2 | UnifiedVectorIndex 检索结果 | `knowledge_node` / `study_note` / `material` / `file_content` |
| 3 | 用户指定节点 ID | `knowledge_node` |
| 4 | 上下文中的 fileContents | `file_content` |
| 5 | 用户上传的 draftId | `file_content` |

每条 Citation 携带：`type`、`sourceId`、`title`、`papercore`、`tags`、`pageNumber`、`snippet`、`fileName`

### 1.5 客户端渲染

- Markdown 渲染（KaTeX 公式 + 代码块）
- 5 色引用卡片：

| 类型 | 颜色 | 展示内容 |
|---|---|---|
| `image` | 🟡 黄色 | 图片名称 + 分析摘要 |
| `knowledge_node` | 🟣 紫色 | Papercore + 关联知识库节点 |
| `study_note` | 🟢 绿色 | Title + Papercore + Tags |
| `material` | 🟠 橙色 | Name + Papercore + Tags |
| `file_content` | ⬜ 灰色 | 文件名 + 蓝色页码 badge + 原文 snippet |

### 1.6 学习闭环

- 用户点击「我明白了！记录到问题日志」→ 将问答对 + citations 存入 `problem_solving_logs` 表
- 会话历史存入 `chat_sessions` / `chat_messages` 表
- 问题日志在 `problem-solving-logs` 页面聚合展示（总数、活跃天数、每日趋势折线图）

---

## 二、Reflection Mind（反思助手）工作流

### 2.1 触发方式

| 入口 | 路径 |
|---|---|
| 专用反思页 `/reflection` | 选择时间窗口（3天/7天/30天）→ 生成报告 |
| AI 聊天 `reflection_mind` | 点击「生成学习反思报告」按钮 |

### 2.2 数据采集

服务端并行采集 4 类数据（均按时间窗口过滤 `created_at`）：

| 数据源 | 数量 | 用途 |
|---|---|---|
| `paper_problem_logs` | 最近 20 条 | 问题解决记录（`/problem-logs` 路由） |
| `problem_solving_logs` | 最近 30 条 | Tutor 问答日志（`/problem-solving-logs` 路由） |
| `reflections` | 最近 5 份 | 往期反思（避免重复建议） |
| `knowledge_nodes` | 最近 50 个 | 知识节点活动 |

### 2.3 LLM 生成与解析

```
System Prompt：你是学习反思助手。分析用户{N}天的学习行为，生成 4 维度报告。

  ## 学习行为（200-400字）
  ## 攻克问题（200-400字）
  ## 思维模式（200-400字）
  ## 学习建议（200-400字）

→ LLM 流式生成 → 正则 /##\s+(标题)\s*\n([\s\S]*?)(?=\n##\s|\n*$)/g 解析
→ 4 个字段存入 reflections 表
```

### 2.4 反思详情页

| 区域 | 内容 |
|---|---|
| 4 张 Section 卡片 | 学习行为（紫）、攻克问题（绿）、思维模式（粉）、学习建议（黄） |
| Q&A 活跃度折线图 | `react-native-chart-kit` LineChart，bezier 曲线 |
| 摘要统计 | 提问总数 + 活跃天数 |
| 系统生成时间戳 | 反思报告的创建时间 |

---

## 三、与市面产品的创新点对比

| 维度 | 现有产品（Notion AI / ChatPDF / 传统 RAG） | PaperMind |
|---|---|---|
| **检索源** | 单一文档或单一数据库 | **4 表统一向量索引**（知识节点 + 学习纪要 + 资料 + 原文片段），跨来源检索 |
| **检索策略** | 纯语义向量 OR 纯关键词 | **双路融合**：Papercore 语义 + Tags 分层（L1/L2/L3）标签匹配 boosting |
| **引用溯源** | 引用文档名或段落 | **结构化 Citations**：5 种类型 + papercore 摘要 + 标签脉络 + PDF 页码 + 原文 snippet |
| **知识组织** | 文档/文件夹扁平面 | **三层标签体系**（L1 学科 → L2 领域 → L3 章节/概念），AI 自动分类 |
| **学习闭环** | 问答即终点 | **问答 → 「我明白了」→ problem_solving_logs → 反思报告**，完整学习循环 |
| **反思总结** | 无 | **多数据源反思引擎**：融合问题日志 + 问答记录 + 往期反思 + 节点活动 |
| **图片理解** | 分开处理 | **图片 + 知识库联合推理**：上传图片同时向量检索相关知识 |
| **运行模式** | 云端 API | **本地嵌入**（BGE ONNX）+ **云端 LLM**（Anthropic 兼容网关） |
| **嵌入模型** | 通用英文模型 | **BGE-small-zh-v1.5**，中文优化，本地运行无网络依赖 |
| **标签匹配** | 无或简单文本匹配 | **语义 + 字面双通道标签匹配**，低阈值余弦 + 子串直击 |

### 核心差异化

PaperMind 不是一个通用问答机器人，而是一个**以知识图谱为骨架、以标签体系为脉络、以反思为闭环**的个性化学习系统。

1. **知识不是静态文档**——用户在学习过程中构建的知识节点和标签实时参与每一次问答的检索和排序
2. **AI 的回答始终锚定在用户自己的知识体系内**——引用来源可追溯到具体的知识节点、学习资料，乃至 PDF 的某一页
3. **学习不是一次性的**——每次问答都被记录，最终汇聚成反思报告，形成"学习 → 提问 → 巩固 → 反思 → 再学习"的飞轮

---

## 四、技术栈

| 层 | 技术 |
|---|---|
| 客户端 | Expo (React Native) + Expo Router + KaTeX |
| 服务端 | Express.js + TypeScript |
| 数据库 | Supabase (PostgreSQL) + Drizzle ORM |
| AI 网关 | Anthropic 兼容 API（`kimi-for-coding` 模型） |
| 嵌入模型 | `Xenova/bge-small-zh-v1.5`（HuggingFace Transformers + ONNX Runtime） |
| 向量维度 | 512 |
| 包管理 | pnpm workspace monorepo |
