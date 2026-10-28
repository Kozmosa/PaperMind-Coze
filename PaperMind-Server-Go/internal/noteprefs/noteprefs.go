// Package noteprefs 对等移植 server/src/utils/note-preferences.ts
// （issue #4 Task 5）：Note Helper 的笔记偏好提取与学科分层。
//
//   - ExtractNotePreferences: LLM 从用户修正指令提取结构化偏好 + 所属学科，
//     任何失败（含未配置 API key）回退关键词规则
//   - NormalizeSubjectPreferences: 兼容旧平铺结构（{detail_level: ...}）
//     与新学科分层结构（{"数学": {...}, "通用": {...}}）
//   - MergeSubjectPreferences: 按学科 key 合并，写回 subject_preferences（JSONB）
//   - FormatSubjectPreferencesForPrompt: 读取端渲染为 prompt 文本
//
// 消费方：internal/api/ai.go（refine-note）与 notes.go（papernote-style）。
// 注意 notes.go 当前带有一份内联精简实现（notePref* 系列，无 subjectHints
// 支持）；本包是覆盖完整 TS API 面（含 subjectHints）的移植，重复实现
// 待架构师裁决收敛（见交付说明 gaps）。
package noteprefs

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"maps"
	"slices"
	"strings"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/aiclient"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
)

// GeneralSubject 对应 note-preferences.ts:13 的 GENERAL_SUBJECT（'通用'）。
const GeneralSubject = "通用"

// ExtractedNotePreference 对应 TS 的 ExtractedNotePreference。
type ExtractedNotePreference struct {
	Subject     string
	Preferences map[string]any
}

// Options 对应 TS 的 options?: { subjectHints?: string[] }。
type Options struct {
	// SubjectHints 是源文件学科标签（如 L1 标签），供 LLM 参考、
	// 回退时取首个非空值兜底学科。
	SubjectHints []string
}

// errNoJSONObject 对应 TS 的 throw new Error('LLM response has no JSON object')，
// 文案保持一致（进入 catch 后仅写日志，不外发）。
var errNoJSONObject = errors.New("LLM response has no JSON object")

// createMessage 为测试缝：单测替换以脱离真实网络（同包 _test 内还原）。
var createMessage = aiclient.CreateMessage

// ExtractPreferencesByKeywords 对应 note-preferences.ts:21-36 的关键词规则
// （LLM 失败时的回退路径）。中文关键词不受 toLowerCase 影响；「详细」与
// 「简洁」同时命中时后者覆盖（与 TS 的顺序赋值一致）。
func ExtractPreferencesByKeywords(refinementPrompt string) map[string]any {
	prefs := map[string]any{}
	prompt := strings.ToLower(refinementPrompt)
	has := func(words ...string) bool {
		for _, w := range words {
			if strings.Contains(prompt, w) {
				return true
			}
		}
		return false
	}
	if has("详细", "展开", "更多") {
		prefs["detail_level"] = "high"
	}
	if has("简洁", "简短", "概括") {
		prefs["detail_level"] = "concise"
	}
	if has("表格", "对比") {
		prefs["prefer_tables"] = true
	}
	if has("例子", "示例", "举例") {
		prefs["prefer_examples"] = true
	}
	if has("重点", "突出", "强调") {
		prefs["emphasize_keypoints"] = true
	}
	if has("通俗", "简单", "易懂") {
		prefs["language_style"] = "plain"
	}
	return prefs
}

// systemPrompt 逐字复刻 note-preferences.ts:54-68 的 system 提示词，
// 学科判断段按 subjectHints 是否非空插值（TS 模板字符串行为）。
func systemPrompt(hints []string) string {
	hintSegment := ""
	if len(hints) > 0 {
		hintSegment = "源文件学科标签供参考：" + strings.Join(hints, "、") + "。"
	}
	return `你是笔记偏好分析助手。用户正在修正一份 AI 生成的学习笔记，请从修正指令中提取用户的笔记风格偏好，并判断偏好所属的学科。

可选偏好键（只输出用户明确表达或强烈暗示的）：
- detail_level: "high"（更详细/展开）或 "concise"（更简洁/概括）
- prefer_tables: true（偏好表格/对比）
- prefer_examples: true（偏好例子/示例）
- emphasize_keypoints: true（偏好突出重点）
- language_style: "plain"（通俗易懂）或 "formal"（严谨正式）
- custom: 字符串，描述其他不好归类的偏好（可选）

学科判断：` + hintSegment + `能判断则填学科名（如 "数学"），无法判断填 "` + GeneralSubject + `"。

只输出一个 JSON 对象，不要任何其他文字：
{"subject": "学科名", "preferences": {...}, "summary": "一句话偏好描述"}
如果修正指令不包含任何风格偏好（只是内容勘误），输出 {"subject": null, "preferences": {}}`
}

// ExtractNotePreferences 对应 note-preferences.ts:43-101：LLM 优先，
// 失败回退关键词。TS 版从不 reject，Go 版同样不返回 error；
// 返回 nil ⇔ TS 返回 null（指令中无可提取偏好，调用方跳过写库）。
func ExtractNotePreferences(ctx context.Context, refinementPrompt string, options *Options) *ExtractedNotePreference {
	var hints []string
	if options != nil {
		for _, h := range options.SubjectHints {
			if h != "" { // TS 的 .filter(Boolean)
				hints = append(hints, h)
			}
		}
	}
	fallbackSubject := GeneralSubject
	if len(hints) > 0 {
		fallbackSubject = hints[0]
	}

	res, err := extractViaLLM(ctx, refinementPrompt, hints, fallbackSubject)
	if err != nil {
		log.Printf("[note-preferences] LLM extraction failed, falling back to keywords: %v", err)
		prefs := ExtractPreferencesByKeywords(refinementPrompt)
		if len(prefs) == 0 {
			return nil
		}
		return &ExtractedNotePreference{Subject: fallbackSubject, Preferences: prefs}
	}
	return res
}

// extractViaLLM 对应 TS 的 try 块：调 LLM、解析 JSON。
// 错误 ⇔ TS 抛出后进 catch 的路径（调用方回退关键词）；
// (nil, nil) ⇔ LLM 明确判定无偏好（TS 的 return null）。
func extractViaLLM(ctx context.Context, refinementPrompt string, hints []string, fallbackSubject string) (*ExtractedNotePreference, error) {
	cfg := config.Load()
	resp, err := createMessage(ctx, aiclient.Request{
		Model:     cfg.DefaultModel,
		MaxTokens: 8192,
		System:    systemPrompt(hints),
		Messages:  []aiclient.InputMessage{{Role: "user", Content: "修正指令：" + refinementPrompt}},
	})
	if err != nil {
		return nil, err
	}
	text := resp.Text()

	// /\{[\s\S]*\}/ 贪婪匹配的等价实现：首个 { 到最后一个 }
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end < start {
		return nil, errNoJSONObject
	}
	var parsed struct {
		Subject     json.RawMessage `json:"subject"`
		Preferences json.RawMessage `json:"preferences"`
		Summary     json.RawMessage `json:"summary"`
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &parsed); err != nil {
		return nil, err
	}

	preferences := map[string]any{}
	// TS：parsed.preferences 为 truthy 对象才采用；JSON 数组虽能通过 typeof
	// 检查，但 Object.keys 为空 → 走「无偏好」分支，与只认 '{' 开头等价
	if len(parsed.Preferences) > 0 && parsed.Preferences[0] == '{' {
		_ = json.Unmarshal(parsed.Preferences, &preferences)
	}
	if len(preferences) == 0 {
		return nil, nil // LLM 明确判定无偏好
	}
	if summary, ok := parseJSONString(parsed.Summary); ok && summary != "" {
		preferences["summary"] = summary // TS：truthy 字符串才并入
	}
	subject := fallbackSubject
	if s, ok := parseJSONString(parsed.Subject); ok && strings.TrimSpace(s) != "" {
		subject = strings.TrimSpace(s)
	}
	return &ExtractedNotePreference{Subject: subject, Preferences: preferences}, nil
}

// parseJSONString 仅当 raw 是 JSON 字符串时解出其值。
func parseJSONString(raw json.RawMessage) (string, bool) {
	if len(raw) > 0 && raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return s, true
		}
	}
	return "", false
}

// NormalizeSubjectPreferences 对应 note-preferences.ts:107-122：把
// subject_preferences 统一为学科分层结构。旧平铺条目（值为标量/数组/null）
// 归入「通用」层；已是分层的原样保留；「通用」层已有值覆盖平铺同名键
// （对应 {...flat, ...layered[GENERAL_SUBJECT]} 的展开顺序）。非对象输入
// （null/数组/标量）返回空 map。
func NormalizeSubjectPreferences(raw any) map[string]map[string]any {
	layered := map[string]map[string]any{}
	m, ok := raw.(map[string]any)
	if !ok {
		return layered
	}
	flat := map[string]any{}
	for k, v := range m {
		if vm, isObj := v.(map[string]any); isObj {
			layered[k] = vm
		} else {
			flat[k] = v
		}
	}
	if len(flat) > 0 {
		merged := maps.Clone(flat)
		if gen, ok := layered[GeneralSubject]; ok {
			maps.Copy(merged, gen) // 已有「通用」层覆盖平铺同名键
		}
		layered[GeneralSubject] = merged
	}
	return layered
}

// MergeSubjectPreferences 对应 note-preferences.ts:125-134：按学科 key
// 合并新偏好（新值覆盖旧值），返回可写回 subject_preferences 的分层对象。
// subject 去首尾空白后为空则归「通用」。
func MergeSubjectPreferences(raw any, subject string, preferences map[string]any) map[string]map[string]any {
	layered := NormalizeSubjectPreferences(raw)
	key := strings.TrimSpace(subject)
	if key == "" {
		key = GeneralSubject
	}
	merged := map[string]any{}
	if base, ok := layered[key]; ok {
		maps.Copy(merged, base)
	}
	maps.Copy(merged, preferences)
	layered[key] = merged
	return layered
}

// FormatSubjectPreferencesForPrompt 对应 note-preferences.ts:140-152：
// 渲染为 prompt 文本，空结构返回「无」；值是字符串原样输出，其余取
// JSON 序列化（同 JSON.stringify）。已知差异：TS 按 Object.keys 插入序
// 输出学科行，Go map 无序，此处按 key 排序保证确定性——仅影响 prompt
// 中的行序，不影响键值内容。
func FormatSubjectPreferencesForPrompt(raw any) string {
	layered := NormalizeSubjectPreferences(raw)
	if len(layered) == 0 {
		return "无"
	}
	lines := make([]string, 0, len(layered))
	for _, subject := range slices.Sorted(maps.Keys(layered)) {
		prefs := layered[subject]
		kvs := make([]string, 0, len(prefs))
		for _, k := range slices.Sorted(maps.Keys(prefs)) {
			kvs = append(kvs, k+"="+stringifyPrefValue(prefs[k]))
		}
		lines = append(lines, subject+"："+strings.Join(kvs, "、"))
	}
	return strings.Join(lines, "\n")
}

// stringifyPrefValue 对应 `${typeof v === 'string' ? v : JSON.stringify(v)}`。
func stringifyPrefValue(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "null" // 理论不可达：值来自 JSON 解码
	}
	return string(b)
}
