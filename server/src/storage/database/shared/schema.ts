import { sql } from "drizzle-orm";
import { pgTable, serial, text, varchar, timestamp, boolean, jsonb, integer, index, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createSchemaFactory } from "drizzle-zod";
import { z } from "zod";

// ==========================================
// 知识库 - 知识节点
// ==========================================
export const knowledgeNodes = pgTable(
  "knowledge_nodes",
  {
    id: serial("id").primaryKey(),
    user_id: varchar("user_id", { length: 36 }),
    original_file: text("original_file"),
    papercore: text("papercore").notNull(),
    short_name: varchar("short_name", { length: 50 }).default(''),
    tags: jsonb("tags").default([]),
    relations: jsonb("relations").default({}),
    attached_draft_ids: jsonb("attached_draft_ids").default([]),
    parent_id: integer("parent_id").references((): AnyPgColumn => knowledgeNodes.id),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("knowledge_nodes_user_id_idx").on(table.user_id),
    index("knowledge_nodes_created_at_idx").on(table.created_at),
  ]
);

const { createInsertSchema: createCoercedInsertSchema } = createSchemaFactory({ coerce: { date: true } });
export const insertKnowledgeNodeSchema = createCoercedInsertSchema(knowledgeNodes).pick({
  papercore: true,
  original_file: true,
  tags: true,
  relations: true,
});
export type KnowledgeNode = typeof knowledgeNodes.$inferSelect;
export type InsertKnowledgeNode = z.infer<typeof insertKnowledgeNodeSchema>;

// ==========================================
// 原始草稿池
// ==========================================
export const draftPool = pgTable(
  "draft_pool",
  {
    id: serial("id").primaryKey(),
    user_id: varchar("user_id", { length: 36 }),
    content: text("content").notNull(),
    file_url: text("file_url"),
    file_name: text("file_name"),
    status: varchar("status", { length: 20 }).notNull().default("unprocessed"),
    notification_sent: boolean("notification_sent").default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("draft_pool_user_id_idx").on(table.user_id),
    index("draft_pool_status_idx").on(table.status),
  ]
);

export const insertDraftSchema = createCoercedInsertSchema(draftPool).pick({
  content: true,
  file_url: true,
  file_name: true,
});
export type DraftPoolItem = typeof draftPool.$inferSelect;
export type InsertDraft = z.infer<typeof insertDraftSchema>;

// ==========================================
// 文件内容提取（OCR/文本提取）
// ==========================================
export const fileContents = pgTable(
  "file_contents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draft_id: integer("draft_id").references(() => draftPool.id, { onDelete: "cascade" }),
    extracted_text: text("extracted_text"),
    page_number: integer("page_number"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("file_contents_draft_id_idx").on(table.draft_id),
  ]
);
export type FileContent = typeof fileContents.$inferSelect;

// ==========================================
// 用户画像 - 笔记风格偏好
// ==========================================
export const papernoteStyle = pgTable(
  "papernote_style",
  {
    id: serial("id").primaryKey(),
    user_id: varchar("user_id", { length: 36 }).unique(),
    general_preference: text("general_preference"),
    subject_preferences: jsonb("subject_preferences").default({}),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("papernote_style_user_id_idx").on(table.user_id),
  ]
);

// ==========================================
// 用户画像 - 问题解决日志
// ==========================================
export const paperProblemLogs = pgTable(
  "paper_problem_logs",
  {
    id: serial("id").primaryKey(),
    user_id: varchar("user_id", { length: 36 }),
    problem: text("problem").notNull(),
    process: text("process"),
    solution: text("solution"),
    knowledge_node_ids: jsonb("knowledge_node_ids").default([]),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("paper_problem_logs_user_id_idx").on(table.user_id),
    index("paper_problem_logs_created_at_idx").on(table.created_at),
  ]
);

// ==========================================
// 用户画像 - 反思
// ==========================================
export const reflections = pgTable(
  "reflections",
  {
    id: serial("id").primaryKey(),
    user_id: varchar("user_id", { length: 36 }),
    learning_behavior: text("learning_behavior"),
    challenge_report: text("challenge_report"),
    thinking_pattern: text("thinking_pattern"),
    suggestion: text("suggestion"),
    period: varchar("period", { length: 50 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("reflections_user_id_idx").on(table.user_id),
    index("reflections_created_at_idx").on(table.created_at),
  ]
);

// ==========================================
// 社区 - 便利贴（省流墙）
// ==========================================
export const stickynotes = pgTable(
  "stickynotes",
  {
    id: serial("id").primaryKey(),
    user_id: varchar("user_id", { length: 36 }),
    author_name: varchar("author_name", { length: 100 }).default("匿名用户"),
    original_material: text("original_material"),
    papercore: text("papercore").notNull(),
    visibility: varchar("visibility", { length: 20 }).notNull().default("public"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("stickynotes_user_id_idx").on(table.user_id),
    index("stickynotes_visibility_idx").on(table.visibility),
    index("stickynotes_created_at_idx").on(table.created_at),
  ]
);

export const insertStickynoteSchema = createCoercedInsertSchema(stickynotes).pick({
  original_material: true,
  papercore: true,
  visibility: true,
  author_name: true,
});
export type Stickynote = typeof stickynotes.$inferSelect;
export type InsertStickynote = z.infer<typeof insertStickynoteSchema>;

// ==========================================
// 社区 - 论坛
// ==========================================
export const forums = pgTable(
  "forums",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(),
    description: text("description"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("forums_type_idx").on(table.type),
  ]
);

// ==========================================
// 社区 - 论坛帖子
// ==========================================
export const forumPosts = pgTable(
  "forum_posts",
  {
    id: serial("id").primaryKey(),
    forum_id: integer("forum_id").notNull().references(() => forums.id, { onDelete: "cascade" }),
    user_id: varchar("user_id", { length: 36 }),
    author_name: varchar("author_name", { length: 100 }).default("匿名用户"),
    title: varchar("title", { length: 200 }).notNull(),
    content: text("content").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("forum_posts_forum_id_idx").on(table.forum_id),
    index("forum_posts_created_at_idx").on(table.created_at),
  ]
);

// ==========================================
// 聊天会话
// ==========================================
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: varchar("user_id", { length: 36 }),
    title: varchar("title", { length: 200 }).default("新对话"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("chat_sessions_user_id_idx").on(table.user_id),
  ]
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    session_id: uuid("session_id").references(() => chatSessions.id, { onDelete: "cascade" }),
    user_id: varchar("user_id", { length: 36 }),
    role: varchar("role", { length: 20 }).notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    citations: jsonb("citations").default([]),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("chat_messages_session_id_idx").on(table.session_id),
  ]
);
