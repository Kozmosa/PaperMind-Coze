package db

import "time"

// 本文件的表结构是 migrations/000_init.sql + 000_init_missing_tables.sql +
// 002~006 迁移的 Go 映射，与 server/src/storage/database/shared/schema.ts
// 的 drizzle 定义逐表核对。字段顺序与列清单保持一致，便于 diff 对照。
//
// JSONB 列的类型约定：
//   - tags / citations / *_ids：TS 侧默认 []，PostgREST 返回 JSON 数组 → 切片
//     （列为 NULL 时解出 nil，与 TS 的 null 语义一致）
//   - relations / subject_preferences：对象 → map[string]any
//   - 不透明 JSONB 一律用 json.RawMessage / []any，由路由组自行细化
//
// 可空列用指针：TS 侧 select('*') 后同样拿到 null。

// KnowledgeNode — knowledge_nodes（000_init.sql:11；schema.ts:20）。
type KnowledgeNode struct {
	ID               int            `json:"id"`
	UserID           *string        `json:"user_id"`
	OriginalFile     *string        `json:"original_file"`
	Papercore        string         `json:"papercore"`
	ShortName        string         `json:"short_name"`
	Tags             []string       `json:"tags"`
	Relations        map[string]any `json:"relations"`
	AttachedDraftIDs []any          `json:"attached_draft_ids"`
	ParentID         *int           `json:"parent_id"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
}

// DraftPoolItem — draft_pool（000_init.sql:30；schema.ts:56）。
type DraftPoolItem struct {
	ID               int        `json:"id"`
	UserID           *string    `json:"user_id"`
	Content          string     `json:"content"`
	FileURL          *string    `json:"file_url"`
	FileName         *string    `json:"file_name"`
	Status           string     `json:"status"`
	NotificationSent bool       `json:"notification_sent"`
	CreatedAt        time.Time  `json:"created_at"`
	ExpiresAt        *time.Time `json:"expires_at"`
}

// FileContent — file_contents（000_init.sql:47；schema.ts:86）。
type FileContent struct {
	ID            string    `json:"id"` // UUID
	DraftID       *int      `json:"draft_id"`
	ExtractedText *string   `json:"extracted_text"`
	PageNumber    *int      `json:"page_number"`
	CreatedAt     time.Time `json:"created_at"`
}

// StudyNote — study_notes（000_init.sql:59 + 004 process_status；schema.ts:102）。
type StudyNote struct {
	ID                 int       `json:"id"`
	UserID             *string   `json:"user_id"`
	Title              *string   `json:"title"`
	Content            *string   `json:"content"`
	Tags               []string  `json:"tags"`
	Papercore          *string   `json:"papercore"`
	LogicalPath        *string   `json:"logical_path"`
	AIProcessed        bool      `json:"ai_processed"`
	ViewedAfterProcess bool      `json:"viewed_after_process"`
	Blocks             []any     `json:"blocks"`
	KnowledgeNodeID    *int      `json:"knowledge_node_id"`
	FileURL            *string   `json:"file_url"`
	FileName           *string   `json:"file_name"`
	ProcessStatus      *string   `json:"process_status"` // migrations/004
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

// Material — materials（000_init.sql:80 + 004 process_status + 005 extracted_text；
// schema.ts:125）。
type Material struct {
	ID                 int       `json:"id"`
	UserID             *string   `json:"user_id"`
	Name               *string   `json:"name"`
	FilePath           *string   `json:"file_path"`
	FileURL            *string   `json:"file_url"`
	FileType           *string   `json:"file_type"`
	Tags               []string  `json:"tags"`
	Papercore          *string   `json:"papercore"`
	LogicalPath        *string   `json:"logical_path"`
	AIProcessed        bool      `json:"ai_processed"`
	ViewedAfterProcess bool      `json:"viewed_after_process"`
	ProcessStatus      *string   `json:"process_status"` // migrations/004
	ExtractedText      *string   `json:"extracted_text"` // migrations/005
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

// PapernoteStyle — papernote_style（000_init.sql:99；schema.ts:146）。
type PapernoteStyle struct {
	ID                 int            `json:"id"`
	UserID             *string        `json:"user_id"` // UNIQUE
	GeneralPreference  *string        `json:"general_preference"`
	SubjectPreferences map[string]any `json:"subject_preferences"`
	CreatedAt          time.Time      `json:"created_at"`
	UpdatedAt          time.Time      `json:"updated_at"`
}

// PaperProblemLog — paper_problem_logs（000_init.sql:112；schema.ts:162）。
type PaperProblemLog struct {
	ID               int       `json:"id"`
	UserID           *string   `json:"user_id"`
	Problem          string    `json:"problem"`
	Process          *string   `json:"process"`
	Solution         *string   `json:"solution"`
	KnowledgeNodeIDs []any     `json:"knowledge_node_ids"`
	CreatedAt        time.Time `json:"created_at"`
}

// ProblemSolvingLog — problem_solving_logs（000_init.sql:127 +
// 002 related_draft_ids + 006 会话总结六列）。
type ProblemSolvingLog struct {
	ID                      int     `json:"id"`
	UserID                  *string `json:"user_id"`
	Question                *string `json:"question"`
	Answer                  *string `json:"answer"`
	Steps                   *string `json:"steps"`
	RelatedKnowledgeNodeIDs []any   `json:"related_knowledge_node_ids"`
	CitationSnippets        []any   `json:"citation_snippets"`
	RelatedDraftIDs         []any   `json:"related_draft_ids"` // migrations/002
	// migrations/006：会话级「我明白了」总结（同一 user+session 唯一，覆盖制）
	ChatSessionID    *string   `json:"chat_session_id"`
	Confusions       []string  `json:"confusions"`
	Mastered         []string  `json:"mastered"`
	QuestionPatterns []string  `json:"question_patterns"`
	OpenQuestions    []string  `json:"open_questions"`
	KnowledgeLinks   []string  `json:"knowledge_links"`
	DepthScore       *int      `json:"depth_score"`
	CreatedAt        time.Time `json:"created_at"`
}

// Reflection — reflections（000_init.sql:141 + 003 raw_text；schema.ts:182）。
type Reflection struct {
	ID               int       `json:"id"`
	UserID           *string   `json:"user_id"`
	LearningBehavior *string   `json:"learning_behavior"`
	ChallengeReport  *string   `json:"challenge_report"`
	ThinkingPattern  *string   `json:"thinking_pattern"`
	Suggestion       *string   `json:"suggestion"`
	Period           *string   `json:"period"`
	RawText          *string   `json:"raw_text"` // migrations/003
	CreatedAt        time.Time `json:"created_at"`
}

// Stickynote — stickynotes（000_init.sql:157；schema.ts:203）。
type Stickynote struct {
	ID               int       `json:"id"`
	UserID           *string   `json:"user_id"`
	AuthorName       string    `json:"author_name"`
	OriginalMaterial *string   `json:"original_material"`
	Papercore        string    `json:"papercore"`
	Visibility       string    `json:"visibility"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// Forum — forums（000_init.sql:174；schema.ts:234）。
type Forum struct {
	ID          int       `json:"id"`
	Name        string    `json:"name"`
	Type        string    `json:"type"`
	Description *string   `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
}

// ForumPost — forum_posts（000_init.sql:186；schema.ts:249）。
type ForumPost struct {
	ID         int       `json:"id"`
	ForumID    int       `json:"forum_id"`
	UserID     *string   `json:"user_id"`
	AuthorName string    `json:"author_name"`
	Title      string    `json:"title"`
	Content    string    `json:"content"`
	CreatedAt  time.Time `json:"created_at"`
}

// ChatSession — chat_sessions（000_init.sql:201；schema.ts:271）。
type ChatSession struct {
	ID        string    `json:"id"` // UUID
	UserID    *string   `json:"user_id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ChatMessage — chat_messages（000_init.sql:213；schema.ts:283）。
type ChatMessage struct {
	ID        string    `json:"id"` // UUID
	SessionID *string   `json:"session_id"`
	UserID    *string   `json:"user_id"`
	Role      string    `json:"role"` // 'user' | 'assistant'
	Content   string    `json:"content"`
	Citations []any     `json:"citations"`
	CreatedAt time.Time `json:"created_at"`
}

// ── 表名常量：防止拼写漂移 ───────────────────────────────────────────

const (
	TableKnowledgeNodes     = "knowledge_nodes"
	TableDraftPool          = "draft_pool"
	TableFileContents       = "file_contents"
	TableStudyNotes         = "study_notes"
	TableMaterials          = "materials"
	TablePapernoteStyle     = "papernote_style"
	TablePaperProblemLogs   = "paper_problem_logs"
	TableProblemSolvingLogs = "problem_solving_logs"
	TableReflections        = "reflections"
	TableStickynotes        = "stickynotes"
	TableForums             = "forums"
	TableForumPosts         = "forum_posts"
	TableChatSessions       = "chat_sessions"
	TableChatMessages       = "chat_messages"
)
