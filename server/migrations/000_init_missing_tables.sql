-- ===========================================
-- PaperMind 补齐缺失的表（study_notes / materials 已存在，自动跳过）
-- 后端使用 service_role key（自动绕过 RLS），故无需建行级安全策略。
-- 全部使用 IF NOT EXISTS，幂等，可放心重复执行。
-- 运行方式：Supabase SQL Editor → 全选本文件内容粘贴 → Run
-- ===========================================

-- 1. knowledge_nodes - 知识图谱节点
CREATE TABLE IF NOT EXISTS public.knowledge_nodes (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36),
    original_file TEXT,
    papercore TEXT NOT NULL,
    short_name VARCHAR(50) DEFAULT '',
    tags JSONB DEFAULT '[]'::jsonb,
    relations JSONB DEFAULT '{}'::jsonb,
    attached_draft_ids JSONB DEFAULT '[]'::jsonb,
    parent_id INTEGER REFERENCES knowledge_nodes(id),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS knowledge_nodes_user_id_idx ON knowledge_nodes(user_id);
CREATE INDEX IF NOT EXISTS knowledge_nodes_created_at_idx ON knowledge_nodes(created_at);

-- 2. draft_pool - 草稿池
CREATE TABLE IF NOT EXISTS public.draft_pool (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36),
    content TEXT NOT NULL,
    file_url TEXT,
    file_name TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'unprocessed',
    notification_sent BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS draft_pool_user_id_idx ON draft_pool(user_id);
CREATE INDEX IF NOT EXISTS draft_pool_status_idx ON draft_pool(status);

-- 3. file_contents - 文本提取结果
CREATE TABLE IF NOT EXISTS public.file_contents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_id INTEGER REFERENCES draft_pool(id) ON DELETE CASCADE,
    extracted_text TEXT,
    page_number INTEGER,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS file_contents_draft_id_idx ON file_contents(draft_id);

-- 4. papernote_style - 用户笔记偏好
CREATE TABLE IF NOT EXISTS public.papernote_style (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36) UNIQUE,
    general_preference TEXT,
    subject_preferences JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS papernote_style_user_id_idx ON papernote_style(user_id);

-- 5. paper_problem_logs - 问题解决日志
CREATE TABLE IF NOT EXISTS public.paper_problem_logs (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36),
    problem TEXT NOT NULL,
    process TEXT,
    solution TEXT,
    knowledge_node_ids JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_problem_logs_user_id_idx ON paper_problem_logs(user_id);
CREATE INDEX IF NOT EXISTS paper_problem_logs_created_at_idx ON paper_problem_logs(created_at);

-- 6. problem_solving_logs - 问答日志
CREATE TABLE IF NOT EXISTS public.problem_solving_logs (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36),
    question TEXT,
    answer TEXT,
    steps TEXT,
    related_knowledge_node_ids JSONB DEFAULT '[]'::jsonb,
    citation_snippets JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- 7. reflections - 学习反思
CREATE TABLE IF NOT EXISTS public.reflections (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36),
    learning_behavior TEXT,
    challenge_report TEXT,
    thinking_pattern TEXT,
    suggestion TEXT,
    period VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS reflections_user_id_idx ON reflections(user_id);
CREATE INDEX IF NOT EXISTS reflections_created_at_idx ON reflections(created_at);

-- 8. stickynotes - 社区便利贴
CREATE TABLE IF NOT EXISTS public.stickynotes (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36),
    author_name VARCHAR(100) DEFAULT '匿名用户',
    original_material TEXT,
    papercore TEXT NOT NULL,
    visibility VARCHAR(20) NOT NULL DEFAULT 'public',
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS stickynotes_user_id_idx ON stickynotes(user_id);
CREATE INDEX IF NOT EXISTS stickynotes_visibility_idx ON stickynotes(visibility);
CREATE INDEX IF NOT EXISTS stickynotes_created_at_idx ON stickynotes(created_at);

-- 9. forums - 社区论坛
CREATE TABLE IF NOT EXISTS public.forums (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(20) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS forums_type_idx ON forums(type);

-- 10. forum_posts - 论坛帖子
CREATE TABLE IF NOT EXISTS public.forum_posts (
    id SERIAL PRIMARY KEY,
    forum_id INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
    user_id VARCHAR(36),
    author_name VARCHAR(100) DEFAULT '匿名用户',
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS forum_posts_forum_id_idx ON forum_posts(forum_id);
CREATE INDEX IF NOT EXISTS forum_posts_created_at_idx ON forum_posts(created_at);

-- 11. chat_sessions - 聊天会话
CREATE TABLE IF NOT EXISTS public.chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(36),
    title VARCHAR(200) DEFAULT '新对话',
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx ON chat_sessions(user_id);

-- 12. chat_messages - 聊天消息
CREATE TABLE IF NOT EXISTS public.chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
    user_id VARCHAR(36),
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    citations JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx ON chat_messages(session_id);
