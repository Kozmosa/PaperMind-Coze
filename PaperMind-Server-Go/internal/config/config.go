package config

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// Config 汇总进程运行所需的全部配置。字段与 TS 侧环境变量一一对应，
// AI 路由组（internal/api/ai.go）只读不改；新增模型配置请加在这里。
type Config struct {
	// ── 服务 ─────────────────────────────────────────────────────────
	// Port 对应 TS index.ts:26 `process.env.PORT || 9091`。
	Port string
	// UploadDir 对应 server/src/config/paths.ts:10 `process.env.UPLOAD_DIR || cwd/uploads`。
	// 注意：默认值相对当前工作目录。从 PaperMind-Server-Go/ 启动时若要与
	// TS server 共用同一批上传文件，请设 UPLOAD_DIR 指向 server/uploads。
	UploadDir string
	// ClientDistDir 对应 TS index.ts:87-88 `CLIENT_DIST_DIR || ../client/dist`。
	ClientDistDir string
	// ServeProjectFiles 对应 TS index.ts:44，仅当值为字符串 "true" 时开启。
	ServeProjectFiles bool
	// BackendBaseURL 对应 routes/materials.ts:220，缺省为 http://localhost:<Port>。
	BackendBaseURL string

	// ── AI 网关（Anthropic 兼容）— server/src/config/ai.ts ──────────
	AnthropicBaseURL string // ANTHROPIC_BASE_URL，空则直连官方 API
	AnthropicAPIKey  string // ANTHROPIC_API_KEY，缺失时服务仍可启动
	// DefaultModel 对应 ai.ts:43 `ANTHROPIC_MODEL || 'kimi-for-coding'`。
	DefaultModel string
	// NoteModel 对应 ai.ts:47 `NOTE_MODEL || 'deepseek-chat'`（快模型）。
	NoteModel string
	// AvailableModels 对应 ai.ts:50 `[DEFAULT_MODEL]`。
	AvailableModels []string

	// ── 视觉 OCR（OpenAI 兼容端点）— ai.ts:58-82 ───────────────────
	VisionAPIKey  string // VISION_API_KEY，缺省回落 ANTHROPIC_API_KEY
	VisionBaseURL string
	VisionModel   string
	// VisionEndpoint 由 BuildVisionEndpoint 计算（见下）。
	VisionEndpoint string

	// ── Embedding（OpenAI 兼容）— server/src/utils/embedding.ts:16-21 ─
	EmbeddingAPIBase string // EMBEDDING_API_BASE，默认 SiliconFlow
	EmbeddingAPIKey  string // EMBEDDING_API_KEY，缺失时仅嵌入链路不可用
	EmbeddingModel   string // EMBEDDING_MODEL，默认 BAAI/bge-m3（1024 维）

	// ── Supabase — supabase-client.ts 与 middleware/auth.ts ────────
	// COZE_* 三件套：数据库 REST 访问（service role 优先，绕过 RLS）。
	CozeSupabaseURL           string
	CozeSupabaseAnonKey       string
	CozeSupabaseServiceRoleKe string
	// 鉴权中间件专用（middleware/auth.ts:18-19）：SUPABASE_URL +
	// SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY。缺省时静默降级 guest。
	SupabaseURL            string
	SupabaseServiceRoleKey string
	SupabaseAnonKey        string
	// /api/v1/config 下发给前端的公开值（index.ts:59-65）。
	ExpoPublicSupabaseURL     string // EXPO_PUBLIC_SUPABASE_URL，缺省回落 COZE_SUPABASE_URL
	ExpoPublicSupabaseAnonKey string // EXPO_PUBLIC_SUPABASE_ANON_KEY，缺省回落 COZE 值
}

var (
	cfgOnce sync.Once
	cfg     *Config
)

// Load 返回进程级单例配置。首次调用时完成 .env 加载与环境变量读取，
// 之后调用直接返回缓存。并发安全。
func Load() *Config {
	cfgOnce.Do(func() {
		LoadDotEnv()

		port := getEnv("PORT", "9091")
		cwd, _ := os.Getwd()

		cfg = &Config{
			Port:      port,
			UploadDir: getEnv("UPLOAD_DIR", filepath.Join(cwd, "uploads")),
			ClientDistDir: getEnv(
				"CLIENT_DIST_DIR", filepath.Join(cwd, "..", "client", "dist"),
			),
			ServeProjectFiles: os.Getenv("SERVE_PROJECT_FILES") == "true",
			BackendBaseURL:    getEnv("BACKEND_BASE_URL", "http://localhost:"+port),

			AnthropicBaseURL: os.Getenv("ANTHROPIC_BASE_URL"),
			AnthropicAPIKey:  os.Getenv("ANTHROPIC_API_KEY"),
			DefaultModel:     getEnv("ANTHROPIC_MODEL", "kimi-for-coding"),
			NoteModel:        getEnv("NOTE_MODEL", "deepseek-chat"),

			VisionAPIKey:  getEnv("VISION_API_KEY", os.Getenv("ANTHROPIC_API_KEY")),
			VisionBaseURL: getEnv("VISION_BASE_URL", "https://api.deepseek.com"),
			VisionModel:   getEnv("VISION_MODEL", "deepseek-v4-flash-vision-exp"),

			EmbeddingAPIBase: strings.TrimRight(
				getEnv("EMBEDDING_API_BASE", "https://api.siliconflow.cn/v1"), "/",
			),
			EmbeddingAPIKey: os.Getenv("EMBEDDING_API_KEY"),
			EmbeddingModel:  getEnv("EMBEDDING_MODEL", "BAAI/bge-m3"),

			CozeSupabaseURL:           os.Getenv("COZE_SUPABASE_URL"),
			CozeSupabaseAnonKey:       os.Getenv("COZE_SUPABASE_ANON_KEY"),
			CozeSupabaseServiceRoleKe: os.Getenv("COZE_SUPABASE_SERVICE_ROLE_KEY"),
			SupabaseURL:               os.Getenv("SUPABASE_URL"),
			SupabaseServiceRoleKey:    os.Getenv("SUPABASE_SERVICE_ROLE_KEY"),
			SupabaseAnonKey:           os.Getenv("SUPABASE_ANON_KEY"),
			ExpoPublicSupabaseURL:     getEnv("EXPO_PUBLIC_SUPABASE_URL", os.Getenv("COZE_SUPABASE_URL")),
			ExpoPublicSupabaseAnonKey: getEnv("EXPO_PUBLIC_SUPABASE_ANON_KEY", os.Getenv("COZE_SUPABASE_ANON_KEY")),
		}

		cfg.VisionEndpoint = BuildVisionEndpoint(cfg.VisionBaseURL)
		cfg.AvailableModels = []string{cfg.DefaultModel}
	})
	return cfg
}

var (
	visionChatCompletionsRe = regexp.MustCompile(`/chat/completions$`)
	visionVersionedRe       = regexp.MustCompile(`(?i)/v\d+[a-z0-9.\-]*$`)
)

// BuildVisionEndpoint 对等移植 server/src/config/ai.ts:69-74：
// OpenAI 习惯补 /v1/chat/completions；网关把版本号放在前缀里
// （如智谱 .../api/paas/v4）时只补 /chat/completions，避免 /v4/v1/... 404。
func BuildVisionEndpoint(baseURL string) string {
	base := strings.TrimRight(baseURL, "/")
	if base == "" {
		return ""
	}
	if visionChatCompletionsRe.MatchString(base) {
		return base
	}
	if visionVersionedRe.MatchString(base) {
		return base + "/chat/completions"
	}
	return base + "/v1/chat/completions"
}
