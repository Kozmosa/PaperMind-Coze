package api

import (
	"log"
	"net/http"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
)

// maxJSONBodyBytes 对应 index.ts:30-31 的 express.json/urlencoded 50MB 限制。
const maxJSONBodyBytes = 50 << 20

// Handler 组装 /api/v1 全部路由，并按 index.ts:49 的顺序先套 authMiddleware，
// 再套 50MB 请求体上限。health/config 与业务路由同等过鉴权（auth 中间件
// 从不拦截，只注入 userId，与 TS 行为一致）。
func Handler() http.Handler {
	mux := http.NewServeMux()

	// index.ts:52-55 — 健康检查
	mux.HandleFunc("GET /api/v1/health", handleHealth)
	// index.ts:59-65 — 前端运行期配置（anon key 设计上即公开值）
	mux.HandleFunc("GET /api/v1/config", handleConfig)

	// 业务路由组（当前全部 501 桩，由各组工程师并行替换）
	registerAIRoutes(mux)
	registerKnowledgeBuilderRoutes(mux)
	registerMaterialsRoutes(mux)
	registerNotesRoutes(mux)
	registerRecordsRoutes(mux)

	return auth.Middleware(withBodyLimit(mux))
}

// withBodyLimit 对应 express.json({ limit: '50mb' })：限制 /api/v1 请求体。
func withBodyLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
		}
		next.ServeHTTP(w, r)
	})
}

// handleHealth 对应 index.ts:52-55。
func handleHealth(w http.ResponseWriter, _ *http.Request) {
	log.Println("Health check success")
	JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleConfig 对应 index.ts:59-65：
// EXPO_PUBLIC_SUPABASE_URL → COZE_SUPABASE_URL 兜底（anon key 同理）。
func handleConfig(w http.ResponseWriter, _ *http.Request) {
	cfg := config.Load()
	JSON(w, http.StatusOK, map[string]string{
		"supabaseUrl":     cfg.ExpoPublicSupabaseURL,
		"supabaseAnonKey": cfg.ExpoPublicSupabaseAnonKey,
	})
}
