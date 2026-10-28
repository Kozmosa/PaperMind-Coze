// Package config 负责加载环境变量与 .env 文件，对等移植 TS 侧的
// server/src/config/ai.ts（dotenv 加载 + AI 模型配置）与
// server/src/storage/database/supabase-client.ts（loadEnv）。
//
// .env 查找顺序沿用 TS 语义（config/ai.ts:15-18、supabase-client.ts:24-26）：
// 先找 <cwd>/.env，不存在再找 <cwd>/../.env，只加载先命中的那一份。
// 从 PaperMind-Server-Go/ 目录启动时，../.env 即仓库根 .env，
// 与 TS server（cwd=server/）的回退文件是同一份。
//
// 与 TS 的差异（有意为之，见 PORTING.md）：.env 中的值不覆盖进程已注入的
// 真实环境变量（标准 dotenv 语义）。TS 侧 supabase-client.loadEnv 使用
// override:true 存在 .env 反超进程环境变量的历史行为，端口阶段不做复刻。
package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	envOnce sync.Once
	envFile string // 实际加载的 .env 路径，供日志与诊断
)

// LoadDotEnv 按 TS 的顺序查找并加载 .env（cwd/.env → ../.env），幂等。
// 已存在于进程环境中的变量不会被覆盖。返回实际加载的文件路径（未找到为空）。
func LoadDotEnv() string {
	envOnce.Do(func() {
		for _, candidate := range envCandidates() {
			if fi, err := os.Stat(candidate); err == nil && !fi.IsDir() {
				envFile = candidate
				loadEnvFile(candidate)
				return
			}
		}
	})
	return envFile
}

// EnvFile 返回 LoadDotEnv 实际加载的 .env 路径（未加载为空字符串）。
func EnvFile() string {
	LoadDotEnv()
	return envFile
}

// envCandidates 返回 .env 查找顺序：当前目录，然后父目录。
// 对应 TS：path.resolve('.env') 不存在时用 path.resolve('..', '.env')。
func envCandidates() []string {
	cwd, err := os.Getwd()
	if err != nil {
		return nil
	}
	return []string{
		filepath.Join(cwd, ".env"),
		filepath.Join(cwd, "..", ".env"),
	}
}

// loadEnvFile 解析 KEY=VALUE 行；忽略空行与 # 注释；剥离成对的单/双引号；
// 不覆盖已存在的环境变量。
func loadEnvFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		value := strings.TrimSpace(line[eq+1:])
		if n := len(value); n >= 2 {
			if (value[0] == '"' && value[n-1] == '"') || (value[0] == '\'' && value[n-1] == '\'') {
				value = value[1 : n-1]
			}
		}
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, value)
		}
	}
}

// getEnv 读取环境变量，空字符串时返回 fallback（等价 TS 的 `process.env.X || def`）。
func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
