package api

import (
	"encoding/json"
	"log"
	"math"
	"math/rand"
	"net/http"
	"sort"

	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/auth"
	"github.com/Kozmosa/PaperMind-Coze/PaperMind-Server-Go/internal/db"
)

// ── GET /graph-data（knowledge-builder.ts:1645-2097）─────────────────
// 知识图谱：Tag 节点（L1/L2/L3 三层）+ 层级/共现边 + 领域圈 +
// 动态同心圆 + 力导向松弛布局。聚合源 = study_notes + materials +
// knowledge_nodes（影子节点跳过，:1688-1701）。

// kbGraphDoc 是聚合输入（一条已分类记录）。
type kbGraphDoc struct {
	RecordID string // `${type}_${id}`
	Tags     []string
}

// kbTagNode 复刻 TagNode（:1705-1715）。parentId 仅 L2/L3 节点有
// （L1 省略该键，omitempty）；documentIds/children 恒为数组。
type kbTagNode struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Level       string   `json:"level"` // 'L1' | 'L2' | 'L3'
	Count       int      `json:"count"`
	DocumentIDs []string `json:"documentIds"`
	ParentID    string   `json:"parentId,omitempty"`
	Children    []string `json:"children"`
	X           float64  `json:"x"`
	Y           float64  `json:"y"`
}

// kbTagEdge 复刻 TagEdge（:1716-1721）。weight 仅共现边有。
type kbTagEdge struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Type   string `json:"type"` // 'hierarchy' | 'cooccurrence'
	Weight int    `json:"weight,omitempty"`
}

// kbGraphDomain 复刻领域圈（:2065-2082）。
type kbGraphDomain struct {
	Name  string  `json:"name"`
	CX    float64 `json:"cx"`
	CY    float64 `json:"cy"`
	R     int     `json:"r"`
	Count int     `json:"count"`
}

// kbGraphData 是 /graph-data 的 data 载荷。
type kbGraphData struct {
	Nodes        []kbTagNode     `json:"nodes"`
	Edges        []kbTagEdge     `json:"edges"`
	Domains      []kbGraphDomain `json:"domains"`
	Canvas       kbCanvas        `json:"canvas"`
	TotalRecords int             `json:"totalRecords"`
}

type kbCanvas struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// kbOrderedTagMap 是保插入序的 TagNode 索引（JS Map 语义：
// Array.from(tagMap.values()) 的迭代顺序 = 插入顺序）。
type kbOrderedTagMap struct {
	order []string
	m     map[string]*kbTagNode
}

func newKbOrderedTagMap() *kbOrderedTagMap {
	return &kbOrderedTagMap{m: map[string]*kbTagNode{}}
}

func (t *kbOrderedTagMap) get(id string) (*kbTagNode, bool) {
	n, ok := t.m[id]
	return n, ok
}

func (t *kbOrderedTagMap) getOrCreate(id, name, level, parentID string) *kbTagNode {
	if n, ok := t.m[id]; ok {
		return n
	}
	n := &kbTagNode{
		ID: id, Name: name, Level: level,
		DocumentIDs: []string{}, Children: []string{},
		ParentID: parentID,
	}
	t.m[id] = n
	t.order = append(t.order, id)
	return n
}

func (t *kbOrderedTagMap) values() []*kbTagNode {
	out := make([]*kbTagNode, len(t.order))
	for i, id := range t.order {
		out[i] = t.m[id]
	}
	return out
}

// kbBuildTagGraph 复刻图谱聚合与布局的纯计算部分（:1704-2082），
// 与 DB 解耦以便单测。docTags 映射（TS 的 docTagMap）在 TS 中写后未读，
// 不移植。
func kbBuildTagGraph(docs []kbGraphDoc) kbGraphData {
	const canvasW, canvasH = 1200.0, 900.0
	cx := canvasW / 2
	cy := canvasH / 2

	tagMap := newKbOrderedTagMap()
	type coocKey struct{ a, b string }
	var coocOrder []coocKey
	cooccurrence := map[coocKey]int{}

	for _, record := range docs {
		tags := record.Tags
		if len(tags) == 0 {
			continue
		}
		l1 := tags[0]
		l2 := ""
		if len(tags) > 1 {
			l2 = tags[1]
		}
		l3List := []string{}
		if len(tags) > 2 {
			l3List = tags[2:]
		}
		recordID := record.RecordID
		var docTags []string

		if l1 != "" {
			l1ID := "tag_L1_" + l1
			docTags = append(docTags, l1ID)
			node := tagMap.getOrCreate(l1ID, l1, "L1", "")
			node.Count++
			if !kbContains(node.DocumentIDs, recordID) {
				node.DocumentIDs = append(node.DocumentIDs, recordID)
			}
		}

		if l2 != "" && l1 != "" {
			l2ID := "tag_L2_" + l1 + "_" + l2
			docTags = append(docTags, l2ID)
			node := tagMap.getOrCreate(l2ID, l2, "L2", "tag_L1_"+l1)
			node.Count++
			if !kbContains(node.DocumentIDs, recordID) {
				node.DocumentIDs = append(node.DocumentIDs, recordID)
			}
			if parent, ok := tagMap.get("tag_L1_" + l1); ok && !kbContains(parent.Children, l2ID) {
				parent.Children = append(parent.Children, l2ID)
			}
		}

		for _, l3 := range l3List {
			if l3 == "" || l1 == "" || l2 == "" {
				continue
			}
			l3ID := "tag_L3_" + l1 + "_" + l2 + "_" + l3
			docTags = append(docTags, l3ID)
			node := tagMap.getOrCreate(l3ID, l3, "L3", "tag_L2_"+l1+"_"+l2)
			node.Count++
			if !kbContains(node.DocumentIDs, recordID) {
				node.DocumentIDs = append(node.DocumentIDs, recordID)
			}
			if parent, ok := tagMap.get("tag_L2_" + l1 + "_" + l2); ok && !kbContains(parent.Children, l3ID) {
				parent.Children = append(parent.Children, l3ID)
			}
		}

		// Co-occurrence: tags appearing in the same document
		for i := 0; i < len(docTags); i++ {
			for j := i + 1; j < len(docTags); j++ {
				a, b := docTags[i], docTags[j]
				if b < a { // JS 字符串比较按码元序，对 BMP 文本与字节序一致
					a, b = b, a
				}
				k := coocKey{a, b}
				if _, exists := cooccurrence[k]; !exists {
					coocOrder = append(coocOrder, k)
				}
				cooccurrence[k]++
			}
		}
	}

	allNodes := tagMap.values()
	var l1Nodes, l2Nodes, l3Nodes []*kbTagNode
	for _, n := range allNodes {
		switch n.Level {
		case "L1":
			l1Nodes = append(l1Nodes, n)
		case "L2":
			l2Nodes = append(l2Nodes, n)
		case "L3":
			l3Nodes = append(l3Nodes, n)
		}
	}

	// Node sizes (radius + text label space)
	getNodeRadius := func(level string) float64 {
		switch level {
		case "L1":
			return 50 // circle 28 + label
		case "L2":
			return 35 // circle 18 + label
		default:
			return 22 // circle 12 + label
		}
	}

	// L1: spread around center
	l1Radius := math.Min(canvasW, canvasH) * 0.18
	for i, node := range l1Nodes {
		n := len(l1Nodes)
		if n < 1 {
			n = 1
		}
		angle := float64(i)/float64(n)*2*math.Pi - math.Pi/2
		node.X = kbRound2(cx + l1Radius*math.Cos(angle))
		node.Y = kbRound2(cy + l1Radius*math.Sin(angle))
	}

	// L2: circle around parent L1 — wider spread for cluster separation
	for _, node := range l2Nodes {
		if node.ParentID == "" {
			continue
		}
		parent, ok := tagMap.get(node.ParentID)
		if !ok {
			node.X = cx + (rand.Float64()-0.5)*200
			node.Y = cy + (rand.Float64()-0.5)*200
			continue
		}
		totalSiblings := len(parent.Children)
		if totalSiblings < 1 {
			totalSiblings = 1
		}
		// Much wider orbit: more L2s = more spread to give each cluster room
		orbitRadius := math.Max(140, float64(80+totalSiblings*40))
		idx := 0
		for i, c := range parent.Children {
			if c == node.ID {
				idx = i
				break
			}
		}
		angle := float64(idx)/float64(totalSiblings)*2*math.Pi - math.Pi/2
		node.X = kbRound2(parent.X + orbitRadius*math.Cos(angle))
		node.Y = kbRound2(parent.Y + orbitRadius*math.Sin(angle))
	}

	// L3: circle around parent L2 — dynamic radius + staggered angles
	for _, node := range l3Nodes {
		if node.ParentID == "" {
			continue
		}
		parent, ok := tagMap.get(node.ParentID)
		if !ok {
			continue
		}
		totalSiblings := len(parent.Children)
		if totalSiblings < 1 {
			totalSiblings = 1
		}
		// More siblings = larger orbit to avoid overlap
		orbitRadius := math.Max(55, float64(20+totalSiblings*16))
		idx := 0
		for i, c := range parent.Children {
			if c == node.ID {
				idx = i
				break
			}
		}
		// Stagger angle slightly if many siblings
		jitter := 0.0
		if totalSiblings > 6 {
			jitter = (rand.Float64() - 0.5) * 0.15
		}
		angle := float64(idx)/float64(totalSiblings)*2*math.Pi - math.Pi/2 + jitter
		node.X = kbRound2(parent.X + orbitRadius*math.Cos(angle))
		node.Y = kbRound2(parent.Y + orbitRadius*math.Sin(angle))
	}

	// ====== Force-directed relaxation: cluster-aware collision avoidance ======
	type simNode struct {
		node         *kbTagNode
		x, y, vx, vy float64
		fixed        bool
		radius       float64
		l2ParentID   string
	}
	var simOrder []string
	simNodes := map[string]*simNode{}
	getSim := func(id string) *simNode { return simNodes[id] }
	for _, node := range allNodes {
		l2Parent := ""
		switch node.Level {
		case "L3":
			l2Parent = node.ParentID
		case "L2":
			l2Parent = node.ID
		}
		simNodes[node.ID] = &simNode{
			node: node, x: node.X, y: node.Y,
			fixed: node.Level == "L1", radius: getNodeRadius(node.Level),
			l2ParentID: l2Parent,
		}
		simOrder = append(simOrder, node.ID)
	}
	simEntries := make([]*simNode, len(simOrder))
	for i, id := range simOrder {
		simEntries[i] = simNodes[id]
	}

	const iterations = 250
	const repulsionBase = 1200.0
	const crossClusterRepulsion = 1500.0 // stronger push between different L2 clusters
	const parentAttractionL2 = 0.012     // L2 → L1 attraction
	const parentAttractionL3 = 0.03      // L3 → L2 attraction (stronger, stay in cluster)
	const damping = 0.65
	const alphaDecay = 0.995

	alpha := 1.0
	for iter := 0; iter < iterations; iter++ {
		alpha *= alphaDecay
		currentRepulsion := repulsionBase * alpha
		currentCrossRep := crossClusterRepulsion * alpha

		// 1. Repulsion between all pairs
		for i := 0; i < len(simEntries); i++ {
			for j := i + 1; j < len(simEntries); j++ {
				a, b := simEntries[i], simEntries[j]
				dx, dy := b.x-a.x, b.y-a.y
				dist := math.Sqrt(dx*dx + dy*dy)
				if dist == 0 {
					dist = 0.1
				}
				// Different L2 clusters → much stronger repulsion and larger safety distance
				sameL2Cluster := a.l2ParentID != "" && b.l2ParentID != "" && a.l2ParentID == b.l2ParentID
				minDist := a.radius + b.radius
				if sameL2Cluster {
					minDist += 8
				} else {
					minDist += 70
				}
				repForce := currentRepulsion
				if !sameL2Cluster {
					repForce += currentCrossRep
				}
				if dist < minDist {
					overlap := minDist - dist
					maxDist := dist
					if maxDist < 8 {
						maxDist = 8
					}
					force := (overlap / minDist) * repForce / maxDist
					fx := (dx / dist) * force
					fy := (dy / dist) * force
					if !a.fixed {
						a.vx -= fx
						a.vy -= fy
					}
					if !b.fixed {
						b.vx += fx
						b.vy += fy
					}
				}
			}
		}

		// 2. Attraction to parent (stronger for L3→L2 to keep clusters tight)
		for _, node := range simEntries {
			if node.fixed || node.node.ParentID == "" {
				continue
			}
			parent := getSim(node.node.ParentID)
			if parent == nil {
				continue
			}
			dx, dy := parent.x-node.x, parent.y-node.y
			dist := math.Sqrt(dx*dx + dy*dy)
			if dist == 0 {
				dist = 0.1
			}
			str := parentAttractionL2
			if node.node.Level == "L3" {
				str = parentAttractionL3
			}
			force := dist * str * alpha
			node.vx += (dx / dist) * force
			node.vy += (dy / dist) * force
		}

		// 3. L2 → L2 extra repulsion (push clusters apart)
		for i := 0; i < len(l2Nodes); i++ {
			for j := i + 1; j < len(l2Nodes); j++ {
				a, b := getSim(l2Nodes[i].ID), getSim(l2Nodes[j].ID)
				if a == nil || b == nil {
					continue
				}
				dx, dy := b.x-a.x, b.y-a.y
				dist := math.Sqrt(dx*dx + dy*dy)
				if dist == 0 {
					dist = 0.1
				}
				minDist := a.radius + b.radius + 120
				if dist < minDist {
					maxDist := dist
					if maxDist < 5 {
						maxDist = 5
					}
					force := ((minDist - dist) / minDist) * currentRepulsion * 1.5 / maxDist
					fx := (dx / dist) * force
					fy := (dy / dist) * force
					a.vx -= fx
					a.vy -= fy
					b.vx += fx
					b.vy += fy
				}
			}
		}

		// 4. Apply velocities
		for _, node := range simEntries {
			if node.fixed {
				continue
			}
			node.vx *= damping
			node.vy *= damping
			speed := math.Sqrt(node.vx*node.vx + node.vy*node.vy)
			if speed > 6 {
				node.vx = (node.vx / speed) * 6
				node.vy = (node.vy / speed) * 6
			}
			node.x += node.vx
			node.y += node.vy
			// Soft boundaries
			margin := node.radius + 15
			if node.x < margin {
				node.vx += (margin - node.x) * 0.3
			}
			if node.x > canvasW-margin {
				node.vx -= (node.x - (canvasW - margin)) * 0.3
			}
			if node.y < margin {
				node.vy += (margin - node.y) * 0.3
			}
			if node.y > canvasH-margin {
				node.vy -= (node.y - (canvasH - margin)) * 0.3
			}
			node.x = math.Max(node.radius+5, math.Min(canvasW-node.radius-5, node.x))
			node.y = math.Max(node.radius+5, math.Min(canvasH-node.radius-5, node.y))
		}
	}

	// Write back simulated positions
	for _, sim := range simEntries {
		sim.node.X = kbRound2(sim.x)
		sim.node.Y = kbRound2(sim.y)
	}

	// ====== Build edges ======
	var edges []kbTagEdge
	// Hierarchical edges（tagMap 插入序）
	for _, node := range allNodes {
		if node.ParentID != "" {
			if _, ok := tagMap.get(node.ParentID); ok {
				edges = append(edges, kbTagEdge{From: node.ParentID, To: node.ID, Type: "hierarchy"})
			}
		}
	}

	// Co-occurrence edges (top 50 by weight)。JS sort 稳定（等权保持插入序）
	type coocEntry struct {
		key    coocKey
		weight int
	}
	coocSorted := make([]coocEntry, len(coocOrder))
	for i, k := range coocOrder {
		coocSorted[i] = coocEntry{key: k, weight: cooccurrence[k]}
	}
	sort.SliceStable(coocSorted, func(i, j int) bool { return coocSorted[i].weight > coocSorted[j].weight })
	if len(coocSorted) > 50 {
		coocSorted = coocSorted[:50]
	}
	for _, e := range coocSorted {
		_, okA := tagMap.get(e.key.a)
		_, okB := tagMap.get(e.key.b)
		if okA && okB {
			edges = append(edges, kbTagEdge{From: e.key.a, To: e.key.b, Type: "cooccurrence", Weight: e.weight})
		}
	}

	// ====== Domain circles (based on L2 tags, dynamic radius from L3 children) ======
	// 按 L2 分组计数：领域粒度落在 L2，演示预期 ≥3 圈（:2062-2082）
	domains := make([]kbGraphDomain, len(l2Nodes))
	for i, node := range l2Nodes {
		maxDist := 0.0
		for _, l3 := range l3Nodes {
			if l3.ParentID == node.ID {
				dx, dy := l3.X-node.X, l3.Y-node.Y
				if d := math.Sqrt(dx*dx+dy*dy) + 25; d > maxDist {
					maxDist = d
				}
			}
		}
		domains[i] = kbGraphDomain{
			Name: node.Name, CX: node.X, CY: node.Y,
			R:     int(math.Max(70, math.Ceil(maxDist))),
			Count: node.Count,
		}
	}

	// 指针视图 → 值切片（响应体节点 = tagMap 插入序）
	nodesOut := make([]kbTagNode, len(allNodes))
	for i, n := range allNodes {
		nodesOut[i] = *n
	}
	return kbGraphData{
		Nodes:        nodesOut,
		Edges:        edges,
		Domains:      domains,
		Canvas:       kbCanvas{Width: int(canvasW), Height: int(canvasH)},
		TotalRecords: len(docs),
	}
}

// handleKnowledgeBuilderGraphData 知识图谱数据。
// 对应 knowledge-builder.ts:1645-2097。
func handleKnowledgeBuilderGraphData(w http.ResponseWriter, r *http.Request) {
	userID := writeUserID(auth.UserID(r.Context()))
	client, ok := dbClient(w)
	if !ok {
		return
	}

	notesRows, err := client.From(db.TableStudyNotes).
		Select("id, title, tags, papercore, logical_path, created_at").
		Eq("user_id", userID).Eq("ai_processed", "true").
		Order("created_at", false).Limit(100).Rows(r.Context())
	if netErr := kbSwallowPostgrest(err); netErr != nil {
		Error(w, http.StatusInternalServerError, netErr.Error())
		return
	}
	materialsRows, err := client.From(db.TableMaterials).
		Select("id, name, tags, papercore, logical_path, created_at").
		Eq("user_id", userID).Eq("ai_processed", "true").
		Order("created_at", false).Limit(100).Rows(r.Context())
	if netErr := kbSwallowPostgrest(err); netErr != nil {
		Error(w, http.StatusInternalServerError, netErr.Error())
		return
	}
	// knowledge_nodes 也参与图谱聚合（issue #7 Task 5）
	nodesRows, err := client.From(db.TableKnowledgeNodes).
		Select("id, short_name, tags, papercore, created_at, original_file").
		Eq("user_id", userID).Order("created_at", false).Limit(100).Rows(r.Context())
	if netErr := kbSwallowPostgrest(err); netErr != nil {
		Error(w, http.StatusInternalServerError, netErr.Error())
		return
	}

	var notesRaw, materialsRaw, nodesRaw []map[string]any
	_ = json.Unmarshal(notesRows, &notesRaw)
	_ = json.Unmarshal(materialsRows, &materialsRaw)
	_ = json.Unmarshal(nodesRows, &nodesRaw)

	log.Printf("[graph-data] notes: %d, materials: %d, nodes: %d",
		len(notesRaw), len(materialsRaw), len(nodesRaw))

	var docs []kbGraphDoc
	for _, n := range notesRaw {
		docs = append(docs, kbGraphDoc{RecordID: "note_" + kbRecordIDString(n["id"]), Tags: kbStringSlice(n["tags"])})
	}
	materialNames := map[string]bool{}
	for _, m := range materialsRaw {
		if name, ok := m["name"].(string); ok {
			materialNames[name] = true
		}
		docs = append(docs, kbGraphDoc{RecordID: "material_" + kbRecordIDString(m["id"]), Tags: kbStringSlice(m["tags"])})
	}
	// 影子节点：材料分类时自动同步生成的知识节点（kbSyncKnowledgeNode），
	// 与文件同名同 tags——文件已直接参与聚合，影子节点是重复的第二份，
	// 跳过使 节点计数=弹窗列表=实际文件数（:1688-1694）
	for _, n := range nodesRaw {
		orig, _ := n["original_file"].(string)
		if orig != "" && materialNames[orig] {
			continue
		}
		docs = append(docs, kbGraphDoc{RecordID: "node_" + kbRecordIDString(n["id"]), Tags: kbStringSlice(n["tags"])})
	}

	OK(w, kbBuildTagGraph(docs))
}

// ── GET /tag-documents（knowledge-builder.ts:2102-2193）─────────────

// handleKnowledgeBuilderTagDocuments 按标签取文档（图谱节点弹窗数据）。
// 三表同 graph-data 口径（含影子节点跳过），按 created_at 倒序。
func handleKnowledgeBuilderTagDocuments(w http.ResponseWriter, r *http.Request) {
	userID := writeUserID(auth.UserID(r.Context()))
	tag := r.URL.Query().Get("tag")
	if tag == "" {
		Error(w, http.StatusBadRequest, "tag query parameter is required")
		return
	}
	client, ok := dbClient(w)
	if !ok {
		return
	}

	notesRows, err := client.From(db.TableStudyNotes).
		Select("id, title, tags, papercore, logical_path, created_at").
		Eq("user_id", userID).Eq("ai_processed", "true").
		Order("created_at", false).Limit(200).Rows(r.Context())
	if netErr := kbSwallowPostgrest(err); netErr != nil {
		Error(w, http.StatusInternalServerError, netErr.Error())
		return
	}
	materialsRows, err := client.From(db.TableMaterials).
		Select("id, name, tags, papercore, logical_path, created_at").
		Eq("user_id", userID).Eq("ai_processed", "true").
		Order("created_at", false).Limit(200).Rows(r.Context())
	if netErr := kbSwallowPostgrest(err); netErr != nil {
		Error(w, http.StatusInternalServerError, netErr.Error())
		return
	}
	// 知识节点也参与图谱聚合（graph-data 同口径）：弹窗必须能列出，
	// 否则「共 N 条关联记录」与列表条数对不上；影子节点跳过（:2128-2136）
	nodesRows, err := client.From(db.TableKnowledgeNodes).
		Select("id, short_name, tags, papercore, created_at, original_file").
		Eq("user_id", userID).Order("created_at", false).Limit(200).Rows(r.Context())
	if netErr := kbSwallowPostgrest(err); netErr != nil {
		Error(w, http.StatusInternalServerError, netErr.Error())
		return
	}

	var notesRaw, materialsRaw, nodesRaw []map[string]any
	_ = json.Unmarshal(notesRows, &notesRaw)
	_ = json.Unmarshal(materialsRows, &materialsRaw)
	_ = json.Unmarshal(nodesRows, &nodesRaw)

	matchTag := func(recordTags any) bool {
		arr, ok := recordTags.([]any)
		if !ok {
			return false // !recordTags || !Array.isArray
		}
		for _, t := range arr {
			if s, isStr := t.(string); isStr && s == tag {
				return true
			}
		}
		return false
	}

	var documents []map[string]any
	for _, n := range notesRaw {
		if !matchTag(n["tags"]) {
			continue
		}
		documents = append(documents, map[string]any{
			"id":           n["id"],
			"title":        kbJSOr(mapStr(n, "title"), "未命名纪要"),
			"type":         "study_note",
			"papercore":    kbJSOr(mapStr(n, "papercore"), ""),
			"tags":         jsOr(n["tags"], []any{}),
			"logical_path": kbJSOr(mapStr(n, "logical_path"), ""),
			"created_at":   kbJSOr(mapStr(n, "created_at"), ""),
		})
	}
	materialNames := map[string]bool{}
	for _, m := range materialsRaw {
		if name, ok := m["name"].(string); ok {
			materialNames[name] = true
		}
	}
	for _, m := range materialsRaw {
		if !matchTag(m["tags"]) {
			continue
		}
		documents = append(documents, map[string]any{
			"id":           m["id"],
			"title":        kbJSOr(mapStr(m, "name"), "未命名资料"),
			"type":         "material",
			"papercore":    kbJSOr(mapStr(m, "papercore"), ""),
			"tags":         jsOr(m["tags"], []any{}),
			"logical_path": kbJSOr(mapStr(m, "logical_path"), ""),
			"created_at":   kbJSOr(mapStr(m, "created_at"), ""),
		})
	}
	for _, n := range nodesRaw {
		orig, _ := n["original_file"].(string)
		isShadow := orig != "" && materialNames[orig]
		if isShadow || !matchTag(n["tags"]) {
			continue
		}
		documents = append(documents, map[string]any{
			"id":           n["id"],
			"title":        kbJSOr(mapStr(n, "short_name"), "知识节点 "+kbRecordIDString(n["id"])),
			"type":         "knowledge_node",
			"papercore":    kbJSOr(mapStr(n, "papercore"), ""),
			"tags":         jsOr(n["tags"], []any{}),
			"logical_path": "",
			"created_at":   kbJSOr(mapStr(n, "created_at"), ""),
		})
	}

	// new Date(b) - new Date(a) 倒序；解析失败的行按零值时间排末尾
	type dated struct {
		t   float64
		row map[string]any
	}
	items := make([]dated, len(documents))
	for i, doc := range documents {
		t := float64(0)
		if s, ok := doc["created_at"].(string); ok {
			if parsed, err := parseJSDate(s); err == nil {
				t = float64(parsed.UnixMilli())
			}
		}
		items[i] = dated{t: t, row: doc}
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].t > items[j].t })
	out := make([]map[string]any, len(items))
	for i, it := range items {
		out[i] = it.row
	}
	OK(w, out)
}
