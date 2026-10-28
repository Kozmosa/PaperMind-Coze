package db

import (
	"context"
	"errors"
	"time"
)

// RunWithRetry 对等移植 supabase-client.ts:150-163 的 runWithRetry：
// 网络瞬时失败（无 Postgres code 的错误）重试；真·查询错误（*PostgrestError）
// 直接返回。调用方把网络类错误抛出来即可触发重试。
//
// TS 签名：runWithRetry(fn, retries = 3, delayMs = 400)，第 i 次重试前
// 等待 delayMs * (i + 1)（线性退避）。materials.ts:109 以 (fn, 4) 调用。
func RunWithRetry[T any](ctx context.Context, fn func() (T, error), retries int, delayMs int) (T, error) {
	var zero T
	var lastErr error
	for i := 0; i <= retries; i++ {
		if i > 0 {
			select {
			case <-time.After(time.Duration(delayMs*i) * time.Millisecond):
			case <-ctx.Done():
				return zero, ctx.Err()
			}
		}
		res, err := fn()
		if err == nil {
			return res, nil
		}
		lastErr = err
		var pErr *PostgrestError
		if errors.As(err, &pErr) {
			// 带 Postgres 错误码：真·查询错误，直接返回
			return zero, err
		}
	}
	return zero, lastErr
}
