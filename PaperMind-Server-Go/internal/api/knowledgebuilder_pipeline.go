package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/aiclient"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/config"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/extracttext"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/retrieval"
)

// ── LLM 管线：papercore 生成 + 全局定位（L1/L2）+ 局部演化（L3）──────
// 对应 knowledge-builder.ts:333-707 的 NEW PIPELINE（纯 LLM，无 embedding）：
//  1. 由原文生成 papercore（generatePapercore）
//  2. 全局定位：LLM 读 papercore + 实时 L1→L2 树定 L1/L2
//  3. 局部演化：LLM 读 papercore + 该 L2 下 top-8 已有 L3 定 L3 标签
// 每篇文档恰一对 L1/L2。LLM 错误全部内部吞掉（TS catch → console.error），
// 绝不向路由抛错。

// kbLLMText 调 Anthropic Messages（DEFAULT_MODEL）并拼接全部文本块后
// trim，对应 anthropic.messages.create + resp.content.filter/map/join/trim。
// 错误原样返回（温度为 0 值时 aiclient 省略 temperature 字段——本组所有
// 调用点均显式传非零值，不受影响）。
func kbLLMText(ctx context.Context, prompt string, maxTokens int, temperature float64) (string, error) {
	resp, err := aiclient.CreateMessage(ctx, aiclient.Request{
		Model:       config.Load().DefaultModel,
		MaxTokens:   maxTokens,
		Temperature: temperature,
		Messages:    []aiclient.InputMessage{{Role: "user", Content: prompt}},
	})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(resp.Text()), nil
}

// kbLLMTextEscalate 复刻「无正文时升档重试」循环（knowledge-builder.ts:374-388
// 等四处）：预算逐档翻倍，拿到非空正文即返回；错误直接上抛（TS 的异常会
// 跳出 for 循环进外层 catch）。label 仅用于日志前缀。
func kbLLMTextEscalate(ctx context.Context, label, prompt string, budgets []int, temperature float64) (string, error) {
	var content string
	for _, budget := range budgets {
		c, err := kbLLMText(ctx, prompt, budget, temperature)
		if err != nil {
			return "", err
		}
		content = c
		if content != "" {
			break
		}
		log.Printf("[%s] 无正文输出（预算 %d），升档重试", label, budget)
	}
	return content, nil
}

// kbGeneratePapercore 复刻 generatePapercore（:343-398）：Step 1，独立生成
// 学术摘要。文本不足 10 字（trim 后）直接降级；超 6000 字取头/中/尾抽样。
// LLM 失败/空输出时用诚实的降级摘要（而非原文开头 150 字）。
func kbGeneratePapercore(ctx context.Context, text, fileName, folderName string) string {
	if kbUTF16Len(kbJSTrim(text)) < 10 {
		// Degraded: no text at all
		return kbBuildDegradedPapercore(fileName, folderName)
	}

	var sampleText string
	if kbUTF16Len(text) > 6000 {
		third := kbUTF16Len(text) / 3 // Math.floor(length / 3)
		sampleText = "[开头]\n" + kbJSSlice(text, 0, 1200) +
			"\n\n[中段]\n" + kbJSSlice(text, third, third+800) +
			"\n\n[末尾]\n" + kbJSSlice(text, -800, kbUTF16Len(text))
	} else {
		sampleText = kbJSSlice(text, 0, 2000)
	}

	prompt := fmt.Sprintf(`你是学术摘要撰写专家。请为以下文档撰写学术摘要（Papercore）。

要求：
1. 输出一段 80-150 字的连贯叙述，涵盖核心定义、公式定理、关键结论
2. 纯文本段落：禁止输出标题、引用块（>）、分隔线（---）、列表或任何 Markdown 结构
3. 数学公式用行内 $...$ 表达（如 $\chi^2$、$t$ 分布），禁止中文或全角符号出现在公式内部
4. 不要复述文档开头的前置知识说明，直接进入主题内容
5. 只输出摘要文本本身

文档内容：%s`, sampleText)

	content, err := kbLLMTextEscalate(ctx, "papercore", prompt, []int{8192, 32768}, 0.3)
	if err != nil {
		log.Printf("[papercore] LLM error: %v", err)
		return kbBuildDegradedPapercore(fileName, folderName)
	}
	if content == "" {
		// LLM 失败时用诚实的降级摘要，而非原文开头 150 字（此前会混入标题/引用块）
		return kbBuildDegradedPapercore(fileName, folderName)
	}
	return content
}

// kbHierTagsResult 是 generateHierarchicalTags 的返回（:481-707）。
type kbHierTagsResult struct {
	L1, L2  string
	L2IsNew bool
	Tags    []string
}

// kbGenerateHierarchicalTags 复刻 Call 2+3（:481-707）：全局定位定 L1/L2
// （含 INVALID 过滤、字符重叠 >75% 吸附已有标签、L2 新建判定），局部演化
// 定 L3（强制复用已有标签 + 新增上限 + 垃圾过滤）。LLM 错误全部吞掉
// （TS catch → console.error）。**网络类错误上抛**：buildL1L2Tree /
// getTopL3sUnderL2 / countL3sUnderL2 在 TS 的内部 try 之外（:509/:594），
// postgrest-js 网络失败会 reject 到调用方的 catch——调用方按各自 TS
// 语境处理（forced 分支 → failed 响应；常规路径 → 500）。
func kbGenerateHierarchicalTags(ctx context.Context, client *db.Client,
	papercore string, textLength int, existingHierarchy *kbTagHierarchy, userID string) (kbHierTagsResult, error) {

	l3NewLimit := kbL3NewLimit(textLength)

	l1 := ""
	l2 := ""
	l2IsNew := false

	// ── Call 2: 全局定位 — 确定 L1/L2 ──
	l1L2Tree, err := kbBuildL1L2Tree(ctx, client, userID)
	if err != nil {
		return kbHierTagsResult{}, err // TS :509 在 try 之外：网络错误直接上抛
	}
	treeText := kbFormatL1L2Tree(l1L2Tree)
	if treeText == "" {
		treeText = "(空 — 首次分类，需新建)"
	}

	globalPrompt := fmt.Sprintf(`你是学科分类专家。请将以下文档归类到学科树中。

现有学科树：
%s

文档摘要：
%s

规则：
1. 精确匹配：如果文档核心内容与某个已有L2高度吻合（该L2的核心课程内容），使用该L2名称（必须与学科树中完全一致）
2. 模糊匹配判别：如果文档核心内容与所有已有L2的核心方向都只是"有数学关联"但实质学科不同（如：线性规划/优化理论 ≠ 概率论、数据挖掘 ≠ 复分析），则应新建L2，不必勉强归类
3. 新建L2命名：选择该学科的正式中文课程/学科名称（如："最优化方法"、"运筹学"、"数值分析"、"统计学"等），避免泛化命名
4. L1命名规则：一级学科名称（如：数学、物理、化学、计算机科学）；如果现有L1都不匹配且无法归类，可建新L1
5. 判断优先级：学科本质匹配 > 表面关键词匹配。不要因为文档中出现了某个学科术语就将整个文档归入该学科

输出JSON（不要markdown代码块）：{"L1":"一级学科", "L2":"二级学科", "reasoning":"简要判断理由"}`,
		treeText, kbJSSlice(papercore, 0, 800))

	// thinking 型模型的思考块会消耗输出预算：无正文时升档重试一次，避免分类静默失败
	c, err := kbLLMTextEscalate(ctx, "global-position", globalPrompt, []int{8192, 32768}, 0.3)
	if err != nil {
		log.Printf("[global-position] LLM error: %v", err)
		c = ""
	}
	if m, ok := pslExtractJSONObject(c); ok {
		var parsed map[string]any
		if jsonErr := json.Unmarshal([]byte(m), &parsed); jsonErr == nil {
			// TS：(parsed.L1 || '').trim()——非字符串会 throw 进 catch，此处等价忽略
			if s, isStr := parsed["L1"].(string); isStr {
				l1 = kbJSTrim(s)
			}
			if s, isStr := parsed["L2"].(string); isStr {
				l2 = kbJSTrim(s)
			}
			reasoning, _ := parsed["reasoning"].(string)
			log.Printf("[global-position] L1=%q L2=%q | %s", l1, l2, reasoning)
		}
	}

	if kbInvalidTagSet[l1] {
		l1 = ""
	}
	if kbInvalidTagSet[l2] {
		l2 = ""
	}

	// Determine if L2 is new（含字符重叠去重：>75% 相似视为同一 L2，防近重复标签）
	if l2 != "" && len(existingHierarchy.L2) > 0 && !kbContains(existingHierarchy.L2, l2) {
		similar := ""
		for _, e := range existingHierarchy.L2 {
			if kbCharOverlapRatio(e, l2) > 0.75 {
				similar = e // find：首个命中
				break
			}
		}
		if similar != "" {
			log.Printf("[global-position] L2=%q 与已有 %q 高度相似（>75%%），复用已有", l2, similar)
			l2 = similar
		} else {
			l2IsNew = true
			log.Printf("[global-position] L2=%q is NEW", l2)
		}
	}

	// L1 guard（issue #7 Task 6）：允许新建 L1（不再强制回落第一个已有 L1），
	// 仅在与已有 L1 字符重叠 >75% 时复用已有，防近重复标签爆炸
	if l1 != "" && len(existingHierarchy.L1) > 0 && !kbContains(existingHierarchy.L1, l1) {
		for _, e := range existingHierarchy.L1 {
			if kbCharOverlapRatio(e, l1) > 0.75 {
				log.Printf("[global-position] L1=%q 与已有 %q 高度相似（>75%%），复用已有", l1, e)
				l1 = e
				break
			}
		}
		// 无相似项：保留新建（TS 只打日志不回落）
	}

	// ── Call 3: 局部演化 — 确定 L3 标签 ──
	var finalL3s []string

	if l1 != "" && l2 != "" {
		topL3s, topErr := kbGetTopL3sUnderL2(ctx, client, userID, l1, l2, papercore, 8)
		if topErr != nil {
			return kbHierTagsResult{}, topErr // TS :594 在 try 之外：网络错误上抛
		}
		l2TotalL3, cntErr := kbCountL3sUnderL2(ctx, client, userID, l1, l2)
		if cntErr != nil {
			return kbHierTagsResult{}, cntErr // 同上
		}

		topL3Text := "(该学科下暂无已有标签)"
		if len(topL3s) > 0 {
			lines := make([]string, len(topL3s))
			for i, t := range topL3s {
				lines[i] = fmt.Sprintf("%d. %q\n   摘要：%s", i+1, t.Name, kbJSSlice(t.Papercore, 0, 150))
			}
			topL3Text = strings.Join(lines, "\n")
		}

		l3Prompt := fmt.Sprintf(`你是章节标签管理专家。请从新文档提取章节标题（L3标签）。

学科路径：%s > %s
该学科下当前共 %d 个标签。

与新文档最相关的已有标签（必须优先复用）：

%s

───

新文档摘要：
%s

规则：
1. 提取文档中的章节/主题标题作为L3 tag
2. 强制复用：如果文档章节与上述已有标签内容相同或高度相似，必须输出已有标签名称（逐字一致），不准改写
3. 每个章节用一个标签，不要把小节拆成独立标签——大章节内的小节归入大章节标签
4. 新增标签不超过 %d 个（文档短则更少）
5. 按文档出现顺序排列

输出JSON数组（不要markdown代码块）：["tag1", "tag2", ...]`,
			l1, l2, l2TotalL3, topL3Text, kbJSSlice(papercore, 0, 600), l3NewLimit)

		resp, llmErr := kbLLMText(ctx, l3Prompt, 8192, 0.3)
		if llmErr != nil {
			log.Printf("[l3-evolution] LLM error: %v", llmErr)
			resp = ""
		}
		if m, ok := kbExtractJSONArray(resp); ok {
			// 解析 + 后处理的任何异常（非数组/非字符串元素）等价 TS 的
			// throw → catch：finalL3s 留空，只记日志
			proposed, propErr := kbParseProposedTags(m)
			if propErr != nil {
				log.Printf("[l3-evolution] LLM error: %v", propErr)
			} else {
				// === Post-process: force-match against existing L3s via char overlap ===
				allExistingL3s, exErr := kbGetAllL3NamesUnderL2(ctx, client, userID, l1, l2)
				if exErr != nil {
					log.Printf("[l3-evolution] LLM error: %v", exErr)
					allExistingL3s = nil
				}
				var matchedL3s, unmatchedL3s []string
				for _, tag := range proposed {
					bestMatch := ""
					bestScore := 0.0
					for _, ex := range allExistingL3s {
						score := kbCharOverlapRatio(tag, ex)
						if score > 0.75 && score > bestScore {
							bestMatch = ex
							bestScore = score
						}
					}
					if bestMatch != "" {
						if !kbContains(matchedL3s, bestMatch) {
							matchedL3s = append(matchedL3s, bestMatch)
							log.Printf("  [l3-force-match] %q → %q (overlap %.0f%%)", tag, bestMatch, bestScore*100)
						}
					} else {
						unmatchedL3s = append(unmatchedL3s, tag)
					}
				}

				// Enforce new-tag limit: only l3NewLimit truly-new tags, rest discarded
				allowedNew := unmatchedL3s
				if len(allowedNew) > l3NewLimit {
					allowedNew = allowedNew[:l3NewLimit]
				}
				finalL3s = append(append([]string{}, matchedL3s...), allowedNew...)
				if len(unmatchedL3s) > l3NewLimit {
					log.Printf("  [l3-limit] %d excess new tags dropped: %s",
						len(unmatchedL3s)-l3NewLimit, strings.Join(unmatchedL3s[l3NewLimit:], ", "))
				}

				notExisting := 0
				for _, t := range matchedL3s {
					if !kbContains(allExistingL3s, t) {
						notExisting++
					}
				}
				log.Printf("[l3-evolution] %s/%s: %d existing → %d after (limit %d)",
					l1, l2, len(allExistingL3s), len(allExistingL3s)+len(allowedNew)-notExisting, l2TotalL3+l3NewLimit)
			}
		}
	}

	// Filter invalid + garbage + L3 must not duplicate parent L2 name (issue #18)
	filteredL3s := kbFilterL3s(finalL3s, l2)
	if len(filteredL3s) != len(finalL3s) {
		var dropped []string
		for _, t := range finalL3s {
			if !kbContains(filteredL3s, t) {
				dropped = append(dropped, t)
			}
		}
		log.Printf("[l3-filter] 过滤垃圾标签: %s", strings.Join(dropped, ", "))
	}

	log.Printf("[tags-result] L1=%q L2=%q l2IsNew=%t L3=[%s]", l1, l2, l2IsNew, strings.Join(filteredL3s, ", "))
	return kbHierTagsResult{L1: l1, L2: l2, L2IsNew: l2IsNew, Tags: filteredL3s}, nil
}

// kbParseProposedTags 复刻 JSON.parse(m[0]).filter(Boolean)：解析 JSON
// 数组并剔假值。非数组 JSON 或含非字符串真值元素时返回错误
// （TS 会在 charOverlapRatio 的 .replace 处 throw TypeError → catch）。
func kbParseProposedTags(m string) ([]string, error) {
	var arr []any
	if err := json.Unmarshal([]byte(m), &arr); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(arr))
	for _, el := range arr {
		if !jsTruthy(el) {
			continue // filter(Boolean)
		}
		s, ok := el.(string)
		if !ok {
			return nil, errors.New("proposed tag is not a string")
		}
		out = append(out, s)
	}
	return out, nil
}

// ── POST /process-content 核心（knowledge-builder.ts:886-1227）────────

// kbProcessContentInner 是 handleProcessContent 的 try 块主体。
// 返回 (status, 响应体对象, error)；error 非空时调用方走 catch-all
// （标记 failed + 500）。
func kbProcessContentInner(ctx context.Context, typ, idRaw any, idStr, userID, fileContent string) (int, any, error) {
	// 参数校验（:891-897）
	if !jsTruthy(typ) || !jsTruthy(idRaw) {
		return http.StatusBadRequest, map[string]any{"error": "type and id are required"}, nil
	}
	typeStr, isStr := typ.(string)
	if !isStr || (typeStr != "study_note" && typeStr != "material") {
		return http.StatusBadRequest, map[string]any{"error": `type must be "study_note" or "material"`}, nil
	}
	table := db.TableStudyNotes
	if typeStr != "study_note" {
		table = db.TableMaterials
	}
	client, err := db.Get()
	if err != nil {
		return 0, nil, err // TS：getSupabaseClient() 抛错 → catch-all 500
	}

	// Fetch the record（:903-912）
	rows, err := client.From(table).Select("*").Eq("id", idStr).Eq("user_id", userID).Single().Rows(ctx)
	if err != nil {
		var pErr *db.PostgrestError
		if errors.As(err, &pErr) {
			// 0 行（PGRST116）等 PostgREST 错误 → 404
			return http.StatusNotFound, map[string]any{"error": "Record not found"}, nil
		}
		return 0, nil, err // 网络类错误 → catch-all
	}
	if isJSONNull(rows) {
		return http.StatusNotFound, map[string]any{"error": "Record not found"}, nil
	}
	var record map[string]any
	if err := json.Unmarshal(rows, &record); err != nil {
		return 0, nil, err
	}

	// Extract text（:917-946）：file_content → 入库 extracted_text → 磁盘 → DB 字段
	dbExtractedText := kbRecordText(record)
	var text string
	switch {
	case fileContent != "" && kbUTF16Len(kbJSTrim(fileContent)) >= 5:
		text = kbStripTOC(fileContent)
	case typeStr == "material" && kbTrimmedLen(kbStrCol(record, "extracted_text")) >= 5:
		// 入库的提取文本（上传同步提取 / 视觉分析回写）优先：不重复读盘
		text = kbStripTOC(kbStrCol(record, "extracted_text"))
		log.Printf("[process-content] 使用入库提取文本（%d 字）for material %s", kbUTF16Len(text), idStr)
	case typeStr == "material":
		// For materials without file_content, always try reading from disk first
		// (DB record only has filename, not useful for AI)
		diskText := kbReadMaterialFileFromDisk(record)
		if diskText != "" && kbUTF16Len(kbJSTrim(diskText)) >= 5 {
			text = kbStripTOC(diskText)
			log.Printf("[process-content] Read %d chars from disk for material %s", kbUTF16Len(text), idStr)
			// 提取文本随分类落库（fire-and-forget，不阻塞分类；TS 的 .then 链）
			go func(table, id, disk string) {
				c, cErr := db.Get()
				if cErr != nil {
					return
				}
				if _, uErr := c.From(table).Eq("id", id).Update(context.Background(),
					map[string]any{"extracted_text": kbJSSlice(disk, 0, 200000)}); uErr != nil {
					log.Printf("[process-content] 持久化提取文本失败: %s", dbErrorMessage(uErr))
				}
			}(table, idStr, diskText)
		} else {
			text = dbExtractedText
		}
	default:
		text = dbExtractedText
	}

	// 提取文件名（:949-950）
	recordFileName := kbRecordFileName(record)

	// Detect unsupported/placeholder content（:953-956）
	isPlaceholder := strings.HasPrefix(text, "[") &&
		(strings.Contains(text, "需OCR") || strings.Contains(text, "旧版PPT") || strings.Contains(text, "无法自动提取"))
	isUnsupported := strings.Contains(text, "旧版PPT二进制格式")

	// 强制解析：即使内容不可读/为空，也根据文件名尝试 LLM 分类（:958-1055）
	if text == "" || kbUTF16Len(kbJSTrim(text)) < 5 || isPlaceholder || isUnsupported {
		if cls := kbClassifyUnreadableByCourse(ctx, client, userID, recordFileName); cls != nil {
			return kbCourseMappedOutcome(ctx, client, table, idRaw, idStr, userID, record, cls)
		}

		forcePapercore := kbBuildDegradedPapercore(recordFileName, "")
		existingHierarchy2, err := kbGetExistingTagHierarchy(ctx, client, userID)
		if err != nil {
			return 0, nil, err // hierarchy 查询在 TS 位于内层 try 之外：网络错误直接进 catch-all
		}
		// TS :1000 的内层 try：分类或写库任一失败 → catch（failed 标记 + 200 failed）
		var l1, l2 string
		var kps []string
		tryErr := func() error {
			forced, gErr := kbGenerateHierarchicalTags(ctx, client, forcePapercore,
				kbUTF16Len(forcePapercore), existingHierarchy2, userID)
			if gErr != nil {
				return gErr
			}
			l1, l2, kps = forced.L1, forced.L2, forced.Tags
			lps := kbBuildLogicalPaths(l1, l2, kps)
			userPath := kbUserSetLogicalPath(record)
			finalLps := lps
			if userPath != "" {
				finalLps = kbParseJSONStringArray(userPath)
			}
			return kbUpdateAIProcessResult(ctx, client, table, map[string]any{
				"ai_processed":   true,
				"papercore":      forcePapercore,
				"logical_path":   kbJSONStringify(finalLps),
				"tags":           kbFilterEmpty(append([]string{l1, l2}, kps...)),
				"process_status": "processed",
			}, idStr, userID)
		}()
		if tryErr != nil {
			// catch：失败不伪装已处理，保持 ai_processed=false 供批次重试
			log.Printf("[forced-classify] error: %s", tryErr.Error())
			userPath := kbUserSetLogicalPath(record)
			logicalPath := "/未分类/" // TS 此分支写裸字符串（非 JSON 数组）
			if userPath != "" {
				logicalPath = userPath
			}
			_, uErr := client.From(table).Eq("id", idStr).Eq("user_id", userID).Update(ctx,
				map[string]any{"process_status": "failed", "logical_path": logicalPath})
			if netErr := kbSwallowPostgrest(uErr); netErr != nil {
				return 0, nil, netErr
			}
			return http.StatusOK, map[string]any{"data": map[string]any{
				"id": idRaw, "status": "failed", "reason": "forced classification failed",
			}}, nil
		}
		{ // finalLps 供响应复用（与写库值一致）
			lps := kbBuildLogicalPaths(l1, l2, kps)
			finalLps := lps
			if userPath := kbUserSetLogicalPath(record); userPath != "" {
				finalLps = kbParseJSONStringArray(userPath)
			}
			if table == db.TableMaterials {
				kbSyncKnowledgeNode(ctx, client, userID, record,
					kbFilterEmpty(append([]string{l1, l2}, kps...)), forcePapercore)
			}
			retrieval.ScheduleIndexRebuild(indexRebuildDelay)
			return http.StatusOK, map[string]any{"data": map[string]any{
				"id":           idRaw,
				"status":       "processed",
				"papercore":    forcePapercore,
				"tags":         append([]string{l1, l2}, kps...),
				"logical_path": finalLps,
				"reason":       "forced",
			}}, nil
		}
	}

	// Check text readability (filter garbled PDF content) — still force classify（:1058-1153）
	if !extracttext.IsReadableText(text) {
		if cls := kbClassifyUnreadableByCourse(ctx, client, userID, recordFileName); cls != nil {
			return kbCourseMappedOutcome(ctx, client, table, idRaw, idStr, userID, record, cls)
		}

		degradedPapercore := kbBuildDegradedPapercore(recordFileName, "")
		existingHierarchy3, err := kbGetExistingTagHierarchy(ctx, client, userID)
		if err != nil {
			return 0, nil, err
		}
		// TS :1098 的内层 try：分类或写库任一失败 → catch（failed 标记 + 200 failed）
		var l1, l2 string
		var kps []string
		tryErr := func() error {
			forced, gErr := kbGenerateHierarchicalTags(ctx, client, degradedPapercore,
				kbUTF16Len(degradedPapercore), existingHierarchy3, userID)
			if gErr != nil {
				return gErr
			}
			l1, l2, kps = forced.L1, forced.L2, forced.Tags
			lps := kbBuildLogicalPaths(l1, l2, kps)
			userPath := kbUserSetLogicalPath(record)
			finalLps := lps
			if userPath != "" {
				finalLps = kbParseJSONStringArray(userPath)
			}
			_, uErr := client.From(table).Eq("id", idStr).Eq("user_id", userID).Update(ctx, map[string]any{
				"ai_processed":   true,
				"papercore":      degradedPapercore,
				"logical_path":   kbJSONStringify(finalLps),
				"tags":           kbFilterEmpty(append([]string{l1, l2}, kps...)),
				"process_status": "processed",
			})
			return kbSwallowPostgrest(uErr) // TS：此 update 未检查 error 字段，网络错误 reject 进 catch
		}()
		if tryErr != nil {
			userPath := kbUserSetLogicalPath(record)
			// 失败不伪装已处理：保持 ai_processed=false 供批次重试，标记 failed
			logicalPath := kbJSONStringify([]string{"/未分类/"}) // 此分支写 JSON 数组串（与 forced 分支的裸串不同）
			if userPath != "" {
				logicalPath = userPath
			}
			_, uErr := client.From(table).Eq("id", idStr).Eq("user_id", userID).Update(ctx,
				map[string]any{"process_status": "failed", "logical_path": logicalPath})
			if netErr := kbSwallowPostgrest(uErr); netErr != nil {
				return 0, nil, netErr
			}
			return http.StatusOK, map[string]any{"data": map[string]any{
				"id": idRaw, "status": "failed", "reason": "degraded classification failed",
			}}, nil
		}
		{
			lps := kbBuildLogicalPaths(l1, l2, kps)
			finalLps := lps
			if userPath := kbUserSetLogicalPath(record); userPath != "" {
				finalLps = kbParseJSONStringArray(userPath)
			}
			if table == db.TableMaterials {
				kbSyncKnowledgeNode(ctx, client, userID, record,
					kbFilterEmpty(append([]string{l1, l2}, kps...)), degradedPapercore)
			}
			retrieval.ScheduleIndexRebuild(indexRebuildDelay)
			return http.StatusOK, map[string]any{"data": map[string]any{
				"id":           idRaw,
				"status":       "processed",
				"papercore":    degradedPapercore,
				"tags":         append([]string{l1, l2}, kps...),
				"logical_path": finalLps,
				"reason":       "forced-degraded",
			}}, nil
		}
	}

	// 常规管线（:1155-1212）
	existingHierarchy, err := kbGetExistingTagHierarchy(ctx, client, userID)
	if err != nil {
		return 0, nil, err
	}
	papercore := kbGeneratePapercore(ctx, text, recordFileName, "")
	result, gErr := kbGenerateHierarchicalTags(ctx, client, papercore, kbUTF16Len(text), existingHierarchy, userID)
	if gErr != nil {
		return 0, nil, gErr // TS：常规路径在 try 内无内层 catch → 进 catch-all 500
	}
	l1, l2, knowledgePoints := result.L1, result.L2, result.Tags
	aiLogicalPaths := kbBuildLogicalPaths(l1, l2, knowledgePoints)
	hierarchicalTags := kbFilterEmpty(append([]string{l1, l2}, knowledgePoints...))

	// Respect user-set logical_path from upload form (don't overwrite with AI)
	//（:1173-1184；getUserSetLogicalPath 已解包历史双嵌套，返回值可直接落库）
	userPath := kbUserSetLogicalPath(record)
	finalLogicalPath := kbJSONStringify(aiLogicalPaths)
	if userPath != "" {
		finalLogicalPath = userPath
		log.Printf("[process-content] Keeping user-set logical_path: %s (AI would have used: %s)",
			finalLogicalPath, kbJSONStringify(aiLogicalPaths))
	}

	if err := kbUpdateAIProcessResult(ctx, client, table, map[string]any{
		"tags":                 hierarchicalTags,
		"papercore":            papercore,
		"logical_path":         finalLogicalPath,
		"ai_processed":         true,
		"process_status":       "processed",
		"viewed_after_process": false,
		"updated_at":           jsNowISO(),
	}, idStr, userID); err != nil {
		return 0, nil, err // updateAiProcessResult 抛错 → catch-all
	}

	if table == db.TableMaterials {
		kbSyncKnowledgeNode(ctx, client, userID, record, hierarchicalTags, papercore)
	}
	retrieval.ScheduleIndexRebuild(indexRebuildDelay)
	return http.StatusOK, map[string]any{"data": map[string]any{
		"id":           idRaw,
		"tags":         hierarchicalTags,
		"papercore":    papercore,
		"logical_path": kbParseJSONStringArray(finalLogicalPath),
		"status":       "processed",
	}}, nil
}

// kbCourseMappedOutcome 复刻 process-content 两处 course-mapped 分支
// （:960-995 与 :1059-1094，两段代码逐字相同）：更新分类结果（错误不
// 检查，网络错误上抛）、同步知识节点、调度索引重建、返回统一响应。
func kbCourseMappedOutcome(ctx context.Context, client *db.Client, table string,
	idRaw any, idStr, userID string, record map[string]any, cls *kbCourseClassifyResult) (int, any, error) {
	coursePapercore := fmt.Sprintf("%s课程资料：%s", cls.L2, cls.Topic)
	lps := kbBuildLogicalPaths(cls.L1, cls.L2, cls.L3s)
	tags := kbFilterEmpty(append([]string{cls.L1, cls.L2}, cls.L3s...))
	if _, uErr := client.From(table).Eq("id", idStr).Eq("user_id", userID).Update(ctx, map[string]any{
		"ai_processed":   true,
		"papercore":      coursePapercore,
		"logical_path":   kbJSONStringify(lps),
		"tags":           tags,
		"process_status": "processed",
	}); kbSwallowPostgrest(uErr) != nil {
		return 0, nil, uErr
	}
	if table == db.TableMaterials {
		kbSyncKnowledgeNode(ctx, client, userID, record, tags, coursePapercore)
	}
	retrieval.ScheduleIndexRebuild(indexRebuildDelay)
	return http.StatusOK, map[string]any{"data": map[string]any{
		"id":           idRaw,
		"status":       "processed",
		"papercore":    coursePapercore,
		"tags":         append([]string{cls.L1, cls.L2}, cls.L3s...),
		"logical_path": lps,
		"reason":       "course-mapped",
	}}, nil
}

// kbRecordFileName 复刻 recordFileName 的取值链（:949-950）：
// record.name || record.title || record.file_name || undefined。
func kbRecordFileName(record map[string]any) string {
	for _, key := range []string{"name", "title", "file_name"} {
		if s, ok := record[key].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// kbStrCol 取行里的字符串列（非字符串/缺失返回空串）。
func kbStrCol(record map[string]any, key string) string {
	s, _ := record[key].(string)
	return s
}

// kbTrimmedLen 返回 trim 后的 UTF-16 长度（text.trim().length 的惯用组合）。
func kbTrimmedLen(s string) int {
	return kbUTF16Len(kbJSTrim(s))
}

// kbParseJSONStringArray 解析 JSON 字符串数组（TS 的 JSON.parse(finalLps)；
// 输入来自 kbJSONStringify/kbUserSetLogicalPath，恒为合法 JSON）。
func kbParseJSONStringArray(s string) []string {
	var out []string
	if err := json.Unmarshal([]byte(s), &out); err != nil {
		return nil
	}
	return out
}
