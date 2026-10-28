// PaperMind-Server-Go 服务入口，对等移植 server/src/index.ts。
//
// 与 TS 的目录基准差异：TS 以 server/ 为工作目录，本服务以
// PaperMind-Server-Go/ 为工作目录——相对路径（../test_data、../debug、
// ../client/dist、仓库根）与 TS 的 ../ 语义指向相同的目标。
// 唯一例外是 uploads：TS 默认 server/uploads，Go 默认 <cwd>/uploads，
// 需共用数据时设 UPLOAD_DIR 指向 server/uploads（见 README）。
package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/api"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/retrieval"
)

func main() {
	cfg := config.Load()
	cwd, _ := os.Getwd()

	root := http.NewServeMux()

	// ── API（index.ts:49-83）──────────────────────────────────────
	// api.Handler 内部已按 TS 顺序套 authMiddleware + 50MB body 限制，
	// health/config 与业务路由同级注册。
	root.Handle("/api/v1/", api.Handler())

	// ── 静态目录（index.ts:32-46）────────────────────────────────
	root.Handle("/uploads/", http.StripPrefix("/uploads/",
		http.FileServer(http.Dir(cfg.UploadDir))))
	root.Handle("/test-data/", http.StripPrefix("/test-data/",
		http.FileServer(http.Dir(filepath.Join(cwd, "..", "test_data", "学习资料")))))
	// debug 测试页迭代频繁，禁缓存避免浏览器跑旧页面（index.ts:34-42）
	root.Handle("/debug/", noCache(http.StripPrefix("/debug/",
		http.FileServer(http.Dir(filepath.Join(cwd, "..", "debug"))))))
	// /projects 会暴露整个仓库（含 .env），仅本地开发按需开启（index.ts:43-46）
	if cfg.ServeProjectFiles {
		root.Handle("/projects/", http.StripPrefix("/projects/",
			http.FileServer(http.Dir(filepath.Join(cwd, "..")))))
	}

	// ── 前端静态产物 + SPA 回退（index.ts:85-97）──────────────────
	// 与 API 同进程托管；本地只跑后端时该目录不存在，自动跳过。
	if index := filepath.Join(cfg.ClientDistDir, "index.html"); fileExists(index) {
		root.Handle("/", spaHandler(cfg.ClientDistDir))
		log.Printf("[static] serving client from %s", cfg.ClientDistDir)
	}

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           cors(root),
		ReadHeaderTimeout: 30 * time.Second,
	}

	// 索引预热钩子（index.ts:103-124）：启动约 2 秒后在后台构建
	// 标签库 → 统一向量索引；embedding 依赖不可用时安全跳过。
	time.AfterFunc(2*time.Second, retrieval.WarmStartIndex)

	log.Printf("Server listening at http://localhost:%s/", cfg.Port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
}

// cors 对等移植 `app.use(cors())`（cors 包默认配置）：
// Allow-Origin: *；方法 GET,HEAD,PUT,PATCH,POST,DELETE；
// 预检请求反射 Access-Control-Request-Headers；OPTIONS 直接 204。
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Add("Vary", "Access-Control-Request-Method")
		w.Header().Add("Vary", "Access-Control-Request-Headers")
		if r.Method == http.MethodOptions {
			if reqHeaders := r.Header.Get("Access-Control-Request-Headers"); reqHeaders != "" {
				w.Header().Set("Access-Control-Allow-Headers", reqHeaders)
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, PATCH, POST, DELETE")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// noCache 给 /debug 静态文件加 Cache-Control: no-cache
// （对齐 express.static 的 setHeaders，index.ts:35-42）。
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		next.ServeHTTP(w, r)
	})
}

// spaHandler 对应 index.ts:90-95 的回退：非 /api/、/uploads/ 的未知 GET
// 路径交给前端路由（返回 index.html）。
func spaHandler(dist string) http.Handler {
	files := http.FileServer(http.Dir(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/uploads/") ||
			strings.Contains(p, "..") {
			http.NotFound(w, r)
			return
		}
		if fileExists(filepath.Join(dist, filepath.FromSlash(p))) {
			files.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
	})
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}
