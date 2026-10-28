package retrieval

import (
	"context"
	"testing"
	"time"
)

func TestScheduleIndexRebuildDebounce(t *testing.T) {
	oldHook := rebuildHook
	signals := make(chan struct{}, 8)
	rebuildHook = func(context.Context) { signals <- struct{}{} }
	t.Cleanup(func() {
		rebuildHook = oldHook
		rebuildMu.Lock()
		if rebuildTimer != nil {
			rebuildTimer.Stop()
			rebuildTimer = nil
		}
		rebuildMu.Unlock()
	})

	// 防抖窗口内的三次调用只触发一次重建（TS 的 if (timer) return）
	ScheduleIndexRebuild(2 * time.Millisecond)
	ScheduleIndexRebuild(2 * time.Millisecond)
	ScheduleIndexRebuild(2 * time.Millisecond)

	select {
	case <-signals:
	case <-time.After(2 * time.Second):
		t.Fatal("防抖窗口内的首次调度未触发重建")
	}
	select {
	case <-signals:
		t.Fatal("窗口内的重复调用应被合并为一次重建")
	case <-time.After(50 * time.Millisecond):
	}

	// timer 归零后可再次调度
	ScheduleIndexRebuild(2 * time.Millisecond)
	select {
	case <-signals:
	case <-time.After(2 * time.Second):
		t.Fatal("防抖窗口结束后应可再次调度")
	}
}
