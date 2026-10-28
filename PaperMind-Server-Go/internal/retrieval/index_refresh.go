package retrieval

import (
	"context"
	"log"
	"sync"
	"time"
)

// rebuildHook 是 rebuildAll 的间接层，仅测试替换；生产恒为 rebuildAll。
var rebuildHook = rebuildAll

var (
	rebuildMu    sync.Mutex
	rebuildTimer *time.Timer
)

// ScheduleIndexRebuild 对应 index-refresh.ts:7-28 的防抖重建：
// 合并 delay 内的多次调用只触发一次重建；重建顺序为先标签库（供加成使用）
// 再统一向量索引，任一失败只 warn 不上抛。TS 默认 delay 5s（5000ms），
// Go 调用方按需传 5*time.Second。
//
// 注意：TS 用单 timer 实现去重；Go 实现应使用 time.AfterFunc + 原子标志
// （或 sync.Once 风格的复位），保证并发调用语义一致。
func ScheduleIndexRebuild(delay time.Duration) {
	rebuildMu.Lock()
	if rebuildTimer != nil {
		rebuildMu.Unlock()
		return // 已有等待中的重建：合并（TS 的 if (timer) return）
	}
	rebuildTimer = time.AfterFunc(delay, func() {
		rebuildMu.Lock()
		rebuildTimer = nil
		rebuildMu.Unlock()
		rebuildHook(context.Background())
	})
	rebuildMu.Unlock()
}

// rebuildAll 供 ScheduleIndexRebuild 与 WarmStartIndex 共用的重建序列：
// 先标签库（统一索引的标签加成依赖它），再统一向量索引。
func rebuildAll(ctx context.Context) {
	if err := TagStore().BuildFromDatabase(ctx); err != nil {
		log.Printf("[Index] TagVectorStore build failed: %v", err)
	}
	if err := Unified().BuildIndex(ctx); err != nil {
		log.Printf("[Index] UnifiedVectorIndex build failed: %v", err)
	}
}
