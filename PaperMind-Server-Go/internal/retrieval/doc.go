// Package retrieval 是检索引擎，对等移植 server/src/utils/ 下的：
//
//	embedding.ts           → embedding.go      （Embed/EmbedBatch/余弦/topK）
//	vector-store.ts        → tag_store.go      （L1/L2/L3 标签向量库）
//	unified-vector-index.ts→ unified_index.go  （文档层统一向量索引）
//	passage-locator.ts     → passage_locator.go（文段级两阶段检索 Stage 2）
//	index-refresh.ts       → index_refresh.go  （防抖索引重建）
//	index.ts 启动预热钩子   → warmstart.go      （WarmStartIndex）
//
// jscompat.go 复刻 JS 字符串边界语义（UTF-16 码元长度 / trim / \s 集合），
// 分块与缓存键指纹依赖这些边界，集中一处避免各处近似。
// TS 源行为以各文件头部的行号引用为准。
//
// 错误约定：TS 版在 search/buildIndex 等入口内部 catch 并降级（返回空数组 /
// 吞掉错误）；Go 版把 error 返回给调用方，由 handler 决定降级策略——
// 对应关系在 PORTING.md「响应/错误格式约定」一节。两处例外按 TS 语义保留：
// LocatePassage 的 error 恒为 nil（TS 全程 catch 返回 null），
// UnifiedVectorIndex.Search 在索引未就绪且构建失败时继续用旧 records 检索。
package retrieval
