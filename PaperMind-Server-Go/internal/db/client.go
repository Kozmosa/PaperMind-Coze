// Package db 对等移植 server/src/storage/database/supabase-client.ts。
//
// 访问路径判定（移植依据）：server/src 内没有任何 pg 直连——
// routes 全部通过 getSupabaseClient() 走 supabase-js 的 PostgREST REST API
// （supabase-client.ts:103-144），drizzle-orm 仅用于 schema.ts 的类型定义，
// `pg` 依赖只被 server/scripts 迁移脚本使用。因此 Go 侧用标准库 HTTP
// 对等实现 PostgREST 客户端，不引入 pgx。
//
// 连接延迟初始化：缺 COZE_SUPABASE_URL / COZE_SUPABASE_ANON_KEY 时
// Get 返回 ErrNotConfigured，进程仍能启动，health/config 照常可用
// （等价 TS 侧“首次调用 getSupabaseClient 才抛错”的惰性行为）。
package db

import (
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
)

// ErrNotConfigured 表示环境变量缺少 Supabase 凭据（COZE_SUPABASE_URL /
// COZE_SUPABASE_ANON_KEY）。对应 supabase-client.ts:88-94 抛出的两条错误。
var ErrNotConfigured = errors.New(
	"db: Supabase credentials not configured (COZE_SUPABASE_URL / COZE_SUPABASE_ANON_KEY)",
)

// requestTimeout 对应 supabase-client.ts:136-138 的 `db: { timeout: 60000 }`。
const requestTimeout = 60 * time.Second

// Client 是 Supabase REST (PostgREST) 客户端，惰性单例。
type Client struct {
	baseURL     string // 形如 https://<project>.supabase.co，不带尾斜杠
	anonKey     string
	apiKey      string // 默认用 service role（绕过 RLS，supabase-client.ts:110-112）
	bearerToken string // WithToken 模式下的用户 JWT（空串表示服务角色模式）
	httpDo      func(*http.Request) (*http.Response, error)
}

var (
	mu       sync.Mutex
	instance *Client
	initErr  error
)

// Get 返回进程级单例客户端；未配置凭据时返回 ErrNotConfigured。
// 对应 TS 的 getSupabaseClient()（无 token 版）。
func Get() (*Client, error) {
	mu.Lock()
	defer mu.Unlock() // 修复：原为 defer mu.Lock()，Go mutex 不可重入，首次调用即整进程死锁（经主代理授权的一个词修复）
	if instance != nil || initErr != nil {
		return instance, initErr
	}
	cfg := config.Load()
	if cfg.CozeSupabaseURL == "" {
		initErr = ErrNotConfigured
		return nil, initErr
	}
	if cfg.CozeSupabaseAnonKey == "" {
		initErr = ErrNotConfigured
		return nil, initErr
	}
	key := cfg.CozeSupabaseServiceRoleKe
	if key == "" {
		key = cfg.CozeSupabaseAnonKey
	}
	instance = &Client{
		baseURL: cfg.CozeSupabaseURL,
		anonKey: cfg.CozeSupabaseAnonKey,
		apiKey:  key,
		httpDo:  (&http.Client{Timeout: requestTimeout}).Do,
	}
	return instance, nil
}

// WithToken 返回携带用户 JWT 的客户端副本（对应 supabase-client.ts:106-109、
// 116-118：token 模式固定用 anon key + Authorization Bearer 头，受 RLS 约束）。
// 目前路由实现均使用无 token 的服务角色模式，保留此入口供后续按需使用。
func (c *Client) WithToken(token string) *Client {
	clone := *c
	clone.apiKey = c.anonKey
	clone.bearerToken = token
	return &clone
}

// RestURL 返回 PostgREST 根地址（供 Query 拼接）。
func (c *Client) RestURL() string {
	return c.baseURL + "/rest/v1"
}
