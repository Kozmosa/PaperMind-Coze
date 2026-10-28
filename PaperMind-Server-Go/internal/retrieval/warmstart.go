package retrieval

import (
	"context"
	"time"
)

// WarmStartIndex 是启动预热钩子入口，对应 server/src/index.ts:104-124：
// listen 后延迟约 2 秒在后台构建 标签库 → 统一向量索引；
// embedding 依赖不可用时安全跳过（只 warn 不影响服务）。
// cmd/server/main.go 用 time.AfterFunc(2*time.Second, retrieval.WarmStartIndex) 调起。
//
// 与 TS 的差异：Go 侧给整个预热加了 10 分钟兜底超时（TS 无全局超时，靠
// 每次 HTTP 请求自身的 60s 超时收敛）——库很大时宁可中断预热也不挂死协程。
func WarmStartIndex() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	rebuildAll(ctx)
}
