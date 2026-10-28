package db

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// PostgrestError 复刻 supabase-js 返回的 PostgREST 错误对象
// （含 code/message/details/hint；42703 缺列、PGRST116 行不存在等
// 被 TS 路由按 code 分支处理，见 problem-solving-logs.ts:152、materials.ts:117）。
type PostgrestError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details string `json:"details"`
	Hint    string `json:"hint"`
}

func (e *PostgrestError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("PostgREST %s: %s", e.Code, e.Message)
	}
	return e.Message
}

// Query 是 supabase-js 查询链的轻量对等物，覆盖 TS 路由实际用到的方法：
// select / eq / not(..., 'is', null) / in / ilike / order / limit /
// single / maybeSingle / insert / update / delete。
//
// 用法（对应 TS 链式调用）：
//
//	rows, err := db.Get().From("knowledge_nodes").
//	    Select("*").Eq("user_id", userID).Order("created_at", false).
//	    Limit(50).Rows(ctx)
//	var nodes []db.KnowledgeNode
//	json.Unmarshal(rows, &nodes)
type Query struct {
	client  *Client
	table   string
	select_ string
	params  url.Values
	single  bool // Accept: application/vnd.pgrst.object+json（对应 .single()）
	maybe   bool // .maybeSingle()：single 但允许 0 行返回 null
}

// From 开始一个表查询（对应 client.from(table)）。
func (c *Client) From(table string) *Query {
	return &Query{
		client:  c,
		table:   table,
		select_: "*",
		params:  make(url.Values),
	}
}

// Select 指定返回列。支持 PostgREST 嵌套选择语法，
// 如 "*, draft_pool(file_url, file_name)"（file-contents.ts:39）。
func (q *Query) Select(cols string) *Query {
	q.select_ = cols
	return q
}

// Eq 对应 .eq(col, val)。
func (q *Query) Eq(col, value string) *Query {
	q.params.Add(col, "eq."+value)
	return q
}

// Not 对应 .not(col, op, val)，如 Not("papercore", "is", "null")
// （unified 索引与 vector-store 用到，TS 写法 .not('papercore','is',null)）。
func (q *Query) Not(col, op, value string) *Query {
	q.params.Add(col, "not."+op+"."+value)
	return q
}

// In 对应 .in(col, values)（file-contents.ts:47）。
func (q *Query) In(col string, values []string) *Query {
	q.params.Add(col, "in.("+strings.Join(values, ",")+")")
	return q
}

// Ilike 对应 .ilike(col, pattern)（file-contents.ts:40）。
func (q *Query) Ilike(col, pattern string) *Query {
	q.params.Add(col, "ilike."+pattern)
	return q
}

// Order 对应 .order(col, { ascending })。
func (q *Query) Order(col string, ascending bool) *Query {
	dir := "desc"
	if ascending {
		dir = "asc"
	}
	q.params.Add("order", col+"."+dir)
	return q
}

// Limit 对应 .limit(n)。
func (q *Query) Limit(n int) *Query {
	q.params.Set("limit", fmt.Sprintf("%d", n))
	return q
}

// Single 对应 .single()：以对象模式请求，0 行时返回错误。
func (q *Query) Single() *Query {
	q.single = true
	q.maybe = false
	return q
}

// MaybeSingle 对应 .maybeSingle()：0 行时 Rows 返回字面量 "null"。
func (q *Query) MaybeSingle() *Query {
	q.single = true
	q.maybe = true
	return q
}

// Rows 执行 SELECT 并返回原始 JSON（数组，或 Single 模式下的对象/null）。
func (q *Query) Rows(ctx context.Context) (json.RawMessage, error) {
	q.params.Set("select", q.select_)
	return q.do(ctx, http.MethodGet, nil)
}

// Insert 对应 .insert(payload).select()：写入并返回新行（return=representation）。
// payload 为可 JSON 序列化的对象或数组。
func (q *Query) Insert(ctx context.Context, payload any) (json.RawMessage, error) {
	return q.doJSON(ctx, http.MethodPost, payload)
}

// Update 对应 .update(payload).select()：更新并返回更新后的行。
// 必须先通过 Eq 限定过滤条件（对应 TS 链上 .eq(...) 的位置）。
func (q *Query) Update(ctx context.Context, payload any) (json.RawMessage, error) {
	return q.doJSON(ctx, http.MethodPatch, payload)
}

// Delete 对应 .delete().select()：删除并返回被删行。
func (q *Query) Delete(ctx context.Context) (json.RawMessage, error) {
	return q.do(ctx, http.MethodDelete, nil)
}

func (q *Query) doJSON(ctx context.Context, method string, payload any) (json.RawMessage, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("db: marshal payload: %w", err)
	}
	return q.do(ctx, method, body)
}

// do 组装并发送 PostgREST 请求。写操作（POST/PATCH/DELETE）带
// Prefer: return=representation，与 supabase-js 的 .select() 尾链一致。
func (q *Query) do(ctx context.Context, method string, body []byte) (json.RawMessage, error) {
	u := q.client.RestURL() + "/" + q.table
	if enc := q.params.Encode(); enc != "" {
		u += "?" + enc
	}

	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("apikey", q.client.apiKey)
	if q.client.bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+q.client.bearerToken)
	} else {
		req.Header.Set("Authorization", "Bearer "+q.client.apiKey)
	}
	req.Header.Set("Accept", "application/json")
	if q.single {
		req.Header.Set("Accept", "application/vnd.pgrst.object+json")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// Prefer: return=representation 对应 supabase-js 尾链 .select()：让
	// PostgREST 返回受影响行。DELETE/PUT 无请求体，必须按方法判断而非
	// 按 body 判断——否则 DELETE 回 204 空体，被删行丢失（对拍实测踩过）。
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		req.Header.Set("Prefer", "return=representation")
	}

	resp, err := q.client.httpDo(req)
	if err != nil {
		return nil, err // 网络类错误：无 Postgres code，供 RunWithRetry 重试
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var pErr PostgrestError
		if jsonErr := json.Unmarshal(data, &pErr); jsonErr == nil && pErr.Message != "" {
			return nil, &pErr
		}
		return nil, fmt.Errorf("db: PostgREST %s %s: HTTP %d: %s",
			method, q.table, resp.StatusCode, truncate(string(data), 300))
	}
	return json.RawMessage(data), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
