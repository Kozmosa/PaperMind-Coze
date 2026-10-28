package retrieval

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
)

// 契约来源：server/src/utils/embedding.ts（OpenAI 兼容 Embedding API，
// 默认 SiliconFlow BAAI/bge-m3，1024 维；配置读 internal/config 的
// EmbeddingAPIBase / EmbeddingAPIKey / EmbeddingModel）。

// 嵌入函数的可替换入口：仅本包单测注入桩实现，生产恒等于 Embed/EmbedBatch。
// 标签库 / 统一索引 / 文段定位内部一律经由这两个变量调用，保证测试离线。
var (
	embedOne  = Embed
	embedMany = EmbedBatch
)

const (
	embedBatchSize      = 32               // 单次请求携带的文本条数（embedding.ts:24）
	embedMaxRetries     = 4                // 429/5xx/网络错误的重试次数（共 5 次尝试）
	embedRequestTimeout = 60 * time.Second // 单请求超时（embedding.ts:26 AbortSignal.timeout(60_000)）
)

// embeddingHTTPClient 不设全局超时——超时由每次请求的 context 控制。
var embeddingHTTPClient = &http.Client{}

// Candidate 对应 findTopK 的候选结构（embedding.ts:139-144）。
type Candidate struct {
	ID   string
	Name string
	Vec  []float64
}

// TopKHit 对应 findTopK 的返回项（embedding.ts:144）。
type TopKHit struct {
	ID    string
	Name  string
	Score float64
}

type embeddingRequest struct {
	Model          string   `json:"model"`
	Input          []string `json:"input"`
	EncodingFormat string   `json:"encoding_format"`
}

type embeddingResponseItem struct {
	Embedding []float64 `json:"embedding"`
	Index     *int      `json:"index"`
}

type embeddingResponse struct {
	Data []embeddingResponseItem `json:"data"`
}

// Embed 为单条文本生成 L2 归一化向量（embedding.ts:106-109）。
// 文本为空/纯空白时按单个空格处理。EMBEDDING_API_KEY 缺失时返回错误
// （服务仍可启动，仅嵌入链路不可用）。
func Embed(text string) ([]float64, error) {
	vecs, err := requestEmbeddings(context.Background(), []string{sanitizeEmbedInput(text)})
	if err != nil {
		return nil, err
	}
	return vecs[0], nil
}

// EmbedBatch 批量嵌入（embedding.ts:115-125）：自动按 32 条/请求分片，
// 返回顺序与入参一一对应；429/5xx/网络错误指数退避重试（最多 4 次，
// 400/800/1600/3200ms），4xx（除 429）直接失败；返回前按 index 还原顺序并做
// L2 归一化（CosineSimilarity 假定单位向量）。
func EmbedBatch(texts []string) ([][]float64, error) {
	if len(texts) == 0 {
		return [][]float64{}, nil
	}
	inputs := make([]string, len(texts))
	for i, t := range texts {
		inputs[i] = sanitizeEmbedInput(t)
	}
	results := make([][]float64, 0, len(inputs))
	for i := 0; i < len(inputs); i += embedBatchSize {
		end := i + embedBatchSize
		if end > len(inputs) {
			end = len(inputs)
		}
		vecs, err := requestEmbeddings(context.Background(), inputs[i:end])
		if err != nil {
			return nil, err
		}
		results = append(results, vecs...)
	}
	return results, nil
}

// sanitizeEmbedInput 对应 TS 的 `text?.trim() || ' '`（空文本嵌入单个空格）。
func sanitizeEmbedInput(s string) string {
	if t := trimJS(s); t != "" {
		return t
	}
	return " "
}

// requestEmbeddings 请求一批文本的向量（embedding.ts:42-101）。
// 失败时对 429 / 5xx / 网络错误做指数退避重试；4xx（除 429）与响应条数
// 异常直接失败——TS 侧这两类错误消息以 “Embedding API ” 开头，会被
// catch 分支立即重新抛出，不参与重试。
func requestEmbeddings(ctx context.Context, inputs []string) ([][]float64, error) {
	cfg := config.Load()
	if cfg.EmbeddingAPIKey == "" {
		return nil, errors.New("EMBEDDING_API_KEY is not set — 请在环境变量中配置 Embedding API Key")
	}
	if len(inputs) == 0 {
		return [][]float64{}, nil
	}

	var lastErr error
	for attempt := 0; attempt <= embedMaxRetries; attempt++ {
		if attempt > 0 {
			// 400 / 800 / 1600 / 3200 ms（embedding.ts:51）
			delay := 400 * time.Duration(1<<uint(attempt-1)) * time.Millisecond
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		reqCtx, cancel := context.WithTimeout(ctx, embedRequestTimeout)
		vecs, retryable, err := embedOnce(reqCtx, cfg, inputs, attempt)
		cancel()
		if err == nil {
			return vecs, nil
		}
		lastErr = err
		if !retryable {
			return nil, err
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, errors.New("Embedding 请求失败")
}

// embedOnce 发送一次 POST /embeddings 请求；retryable 标记错误是否值得重试。
func embedOnce(ctx context.Context, cfg *config.Config, inputs []string, attempt int) ([][]float64, bool, error) {
	payload, err := json.Marshal(embeddingRequest{
		Model:          cfg.EmbeddingModel,
		Input:          inputs,
		EncodingFormat: "float",
	})
	if err != nil {
		return nil, false, fmt.Errorf("构造 Embedding 请求失败: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		cfg.EmbeddingAPIBase+"/embeddings", bytes.NewReader(payload))
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.EmbeddingAPIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := embeddingHTTPClient.Do(req)
	if err != nil {
		// 网络与超时错误：TS 侧进 catch 后重试（embedding.ts:92-97）
		log.Printf("[embedding] 第 %d 次请求异常：%v", attempt+1, err)
		return nil, true, err
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyStr := ""
		if readErr == nil {
			bodyStr = string(body)
		}
		apiErr := fmt.Errorf("Embedding API %d: %s", resp.StatusCode, truncateRunes(bodyStr, 300))
		// 4xx（除 429）属于请求本身的问题，重试无意义（embedding.ts:66-69）
		if resp.StatusCode != 429 && resp.StatusCode < 500 {
			return nil, false, apiErr
		}
		log.Printf("[embedding] 第 %d 次失败(%d)，准备重试", attempt+1, resp.StatusCode)
		return nil, true, apiErr
	}
	if readErr != nil {
		log.Printf("[embedding] 第 %d 次请求异常：%v", attempt+1, readErr)
		return nil, true, readErr
	}

	var decoded embeddingResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		// TS：res.json() 失败同样进 catch 走重试
		log.Printf("[embedding] 第 %d 次请求异常：%v", attempt+1, err)
		return nil, true, fmt.Errorf("解析 Embedding 响应失败: %w", err)
	}
	if len(decoded.Data) != len(inputs) {
		return nil, false, fmt.Errorf("Embedding API 返回条数异常：期望 %d 条，实得 %d 条", len(inputs), len(decoded.Data))
	}

	// 按 index 还原顺序（接口不保证返回顺序，缺 index 时按数组顺序，embedding.ts:85-90）。
	ordered := make([][]float64, len(inputs))
	for i, item := range decoded.Data {
		idx := i
		if item.Index != nil {
			idx = *item.Index
		}
		// TS 对越界 index 会在数组留下 undefined 槽位（后续解构得到 undefined）；
		// Go 显式报错，避免把坏向量静默传进检索（比 TS 更严格，已在 gaps 登记）
		if idx < 0 || idx >= len(inputs) {
			return nil, false, fmt.Errorf("Embedding API 返回 index 越界：%d", idx)
		}
		ordered[idx] = normalize(item.Embedding)
	}
	for _, v := range ordered {
		if v == nil {
			return nil, false, errors.New("Embedding API 返回数据不完整（index 重复或缺失）")
		}
	}
	return ordered, false, nil
}

// normalize 做 L2 归一化（embedding.ts:29-35）：CosineSimilarity 用点积，
// 必须保证单位向量；零向量原样返回（norm 为 0 时除法无意义）。
func normalize(vec []float64) []float64 {
	var sum float64
	for _, v := range vec {
		sum += v * v
	}
	norm := math.Sqrt(sum)
	if norm == 0 {
		return vec
	}
	out := make([]float64, len(vec))
	for i, v := range vec {
		out[i] = v / norm
	}
	return out
}

// CosineSimilarity 计算两个已归一化向量的余弦相似度（= 点积，embedding.ts:130-134）。
// TS 版按 a.length 求和，长度不一致时 b[i] 为 undefined、结果 NaN；Go 取公共
// 前缀求和。实际调用中两向量要么等长，要么 b 为空（嵌入失败的兜底空数组）——
// 空向量得 0 分，同样会被各处 minScore 阈值过滤，与 TS 的 NaN 路径殊途同归。
func CosineSimilarity(a, b []float64) float64 {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	var dot float64
	for i := 0; i < n; i++ {
		dot += a[i] * b[i]
	}
	return dot
}

// FindTopK 从候选集中取相似度 ≥ threshold 的前 k 个（embedding.ts:139-150），
// 按 score 降序；TS 的 Array.prototype.sort 是稳定排序，同分保持候选顺序。
func FindTopK(queryVec []float64, candidates []Candidate, k int, threshold float64) []TopKHit {
	hits := make([]TopKHit, 0, len(candidates))
	for _, c := range candidates {
		if score := CosineSimilarity(queryVec, c.Vec); score >= threshold {
			hits = append(hits, TopKHit{ID: c.ID, Name: c.Name, Score: score})
		}
	}
	sort.SliceStable(hits, func(x, y int) bool { return hits[x].Score > hits[y].Score })
	if k >= 0 && len(hits) > k {
		hits = hits[:k]
	}
	return hits
}
