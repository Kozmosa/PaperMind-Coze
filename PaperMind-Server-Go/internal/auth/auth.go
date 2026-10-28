// Package auth 对等移植 server/src/middleware/auth.ts：
// X-Session 请求头 → Supabase /auth/v1/user 验证，5 分钟内存缓存，
// 无凭据 / 配置缺失 / 验证失败时一律静默降级为 guest 用户，绝不拦截请求。
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
)

// GuestUserID 对应 auth.ts:4 的兜底用户 ID（全 1 的占位 UUID）。
const GuestUserID = "11111111-1111-1111-1111-111111111111"

// cacheTTL 对应 auth.ts:44 的 5 分钟缓存。
const cacheTTL = 5 * time.Minute

// httpClientTimeout：TS fetch 未显式设超时，Go 侧给一个防御性上限，
// 避免 Supabase 网络抖动长期占用请求 goroutine。
const httpClientTimeout = 15 * time.Second

// sessionHeader 对应 auth.ts:9 `req.headers['x-session']`。
const sessionHeader = "X-Session"

type cacheEntry struct {
	userID    string
	expiresAt time.Time
}

// Verifier 持有 token→userID 缓存与 Supabase 验证逻辑，可被单测替换 HTTP 传输。
type Verifier struct {
	mu          sync.Mutex
	cache       map[string]cacheEntry
	httpDo      func(*http.Request) (*http.Response, error)
	supabaseURL string
	apiKey      string
}

// NewVerifier 依据环境变量构建验证器。SUPABASE_URL 或
// SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY 缺失时返回 nil
// （等价 auth.ts:20-23 的“无凭据 → guest”分支）。
func NewVerifier() *Verifier {
	cfg := config.Load()
	key := cfg.SupabaseServiceRoleKey
	if key == "" {
		key = cfg.SupabaseAnonKey
	}
	if cfg.SupabaseURL == "" || key == "" {
		return nil
	}
	return &Verifier{
		cache:       make(map[string]cacheEntry),
		supabaseURL: cfg.SupabaseURL,
		apiKey:      key,
		httpDo:      (&http.Client{Timeout: httpClientTimeout}).Do,
	}
}

// Middleware 对等移植 authMiddleware：挂载在 /api/v1 之前，
// 把解析出的 userId 放入 request context，任何失败路径都降级为 GuestUserID。
func Middleware(next http.Handler) http.Handler {
	verifier := NewVerifier()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := resolveUserID(verifier, r)
		next.ServeHTTP(w, r.WithContext(WithUserID(r.Context(), userID)))
	})
}

// resolveUserID 复刻 auth.ts:8-56 的完整判定链。
func resolveUserID(v *Verifier, r *http.Request) string {
	token := r.Header.Get(sessionHeader)
	if token == "" {
		// auth.ts:11-14 无 token → guest（向后兼容）
		return GuestUserID
	}
	if v == nil {
		// auth.ts:20-23 Supabase 凭据未配置 → guest
		return GuestUserID
	}

	// auth.ts:26-29 先查缓存
	if userID, ok := v.cached(token); ok {
		return userID
	}

	// auth.ts:33-38 请求 Supabase /auth/v1/user 验证
	userID, err := v.verify(r.Context(), token)
	if err != nil {
		// auth.ts:50-53 网络等异常：记日志后降级 guest
		log.Printf("Auth middleware error: %v", err)
		return GuestUserID
	}
	if userID == "" {
		// auth.ts:46-48 无效 token → guest
		return GuestUserID
	}

	v.store(token, userID)
	return userID
}

func (v *Verifier) cached(token string) (string, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	entry, ok := v.cache[token]
	if !ok || !time.Now().Before(entry.expiresAt) {
		return "", false
	}
	return entry.userID, true
}

func (v *Verifier) store(token, userID string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.cache[token] = cacheEntry{userID: userID, expiresAt: time.Now().Add(cacheTTL)}
}

// verify 调用 Supabase auth 端点，返回用户 ID；非 2xx 返回空串。
func (v *Verifier) verify(ctx context.Context, token string) (string, error) {
	req, err := http.NewRequestWithContext(
		ctx, http.MethodGet, v.supabaseURL+"/auth/v1/user", nil,
	)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("apikey", v.apiKey)

	resp, err := v.httpDo(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", nil // 无效 token：静默降级，不作为错误上报
	}

	var user struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return "", fmt.Errorf("decode /auth/v1/user response: %w", err)
	}
	// auth.ts:42 `user?.id || GUEST_USER_ID`
	if user.ID == "" {
		return GuestUserID, nil
	}
	return user.ID, nil
}

// ── context 传递 ────────────────────────────────────────────────────
// TS 侧通过 `(req as any).userId` 附加；Go 侧用 context value，等价能力。

type ctxKey struct{}

// WithUserID 把 authMiddleware 解析出的 userId 写入 context。
func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, ctxKey{}, userID)
}

// UserID 读取请求用户 ID。未经过 auth 中间件的 context 返回空串。
// TS 各路由的 `(req as any).userId || 'guest'` 兜底写法在 Go 侧应写成
// `auth.UserID(r.Context())` 并按需兜底（各路由兜底值不同：'guest'/'temp_user'）。
func UserID(ctx context.Context) string {
	if v, ok := ctx.Value(ctxKey{}).(string); ok {
		return v
	}
	return ""
}
