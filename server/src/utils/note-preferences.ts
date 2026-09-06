/**
 * Note Helper 笔记偏好提取与学科分层（issue #4 Task 5）
 *
 * - extractNotePreferences: 用 LLM 从用户修正指令中提取结构化偏好 + 所属学科，
 *   LLM 失败时回退到关键词规则
 * - normalizeSubjectPreferences: 兼容旧的平铺结构（{detail_level: ...}）
 *   和新的学科分层结构（{"数学": {...}, "通用": {...}}）
 * - mergeSubjectPreferences: 按学科 key 合并写入 subject_preferences（JSONB，不改表结构）
 */

import { anthropic, DEFAULT_MODEL } from '../config/ai.js';

export const GENERAL_SUBJECT = '通用';

export interface ExtractedNotePreference {
  subject: string;
  preferences: Record<string, any>;
}

// 现有关键词规则（LLM 失败时的回退路径，也是papernote-style/refine-note 原本的实现）
export function extractPreferencesByKeywords(refinementPrompt: string): Record<string, any> {
  const prefs: Record<string, any> = {};
  const prompt = refinementPrompt.toLowerCase();
  if (prompt.includes('详细') || prompt.includes('展开') || prompt.includes('更多'))
    prefs.detail_level = 'high';
  if (prompt.includes('简洁') || prompt.includes('简短') || prompt.includes('概括'))
    prefs.detail_level = 'concise';
  if (prompt.includes('表格') || prompt.includes('对比')) prefs.prefer_tables = true;
  if (prompt.includes('例子') || prompt.includes('示例') || prompt.includes('举例'))
    prefs.prefer_examples = true;
  if (prompt.includes('重点') || prompt.includes('突出') || prompt.includes('强调'))
    prefs.emphasize_keypoints = true;
  if (prompt.includes('通俗') || prompt.includes('简单') || prompt.includes('易懂'))
    prefs.language_style = 'plain';
  return prefs;
}

/**
 * 从修正指令中提取笔记偏好：优先 LLM（结构化偏好 + 学科），失败回退关键词。
 * subjectHints：源文件的学科标签（如 L1 标签），供 LLM 参考 / 回退时兜底。
 * 返回 null 表示指令中没有任何可提取的偏好（调用方跳过写库）。
 */
export async function extractNotePreferences(
  refinementPrompt: string,
  options?: { subjectHints?: string[] },
): Promise<ExtractedNotePreference | null> {
  const hints = (options?.subjectHints || []).filter(Boolean);
  const fallbackSubject = hints[0] || GENERAL_SUBJECT;

  try {
    const msg = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 512,
      system: `你是笔记偏好分析助手。用户正在修正一份 AI 生成的学习笔记，请从修正指令中提取用户的笔记风格偏好，并判断偏好所属的学科。

可选偏好键（只输出用户明确表达或强烈暗示的）：
- detail_level: "high"（更详细/展开）或 "concise"（更简洁/概括）
- prefer_tables: true（偏好表格/对比）
- prefer_examples: true（偏好例子/示例）
- emphasize_keypoints: true（偏好突出重点）
- language_style: "plain"（通俗易懂）或 "formal"（严谨正式）
- custom: 字符串，描述其他不好归类的偏好（可选）

学科判断：${hints.length > 0 ? `源文件学科标签供参考：${hints.join('、')}。` : ''}能判断则填学科名（如 "数学"），无法判断填 "${GENERAL_SUBJECT}"。

只输出一个 JSON 对象，不要任何其他文字：
{"subject": "学科名", "preferences": {...}, "summary": "一句话偏好描述"}
如果修正指令不包含任何风格偏好（只是内容勘误），输出 {"subject": null, "preferences": {}}`,
      messages: [{ role: 'user', content: `修正指令：${refinementPrompt}` }],
    });

    const text = msg.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const preferences =
        parsed.preferences && typeof parsed.preferences === 'object' ? parsed.preferences : {};
      if (Object.keys(preferences).length > 0) {
        if (parsed.summary && typeof parsed.summary === 'string') {
          preferences.summary = parsed.summary;
        }
        const subject =
          typeof parsed.subject === 'string' && parsed.subject.trim()
            ? parsed.subject.trim()
            : fallbackSubject;
        return { subject, preferences };
      }
      // LLM 明确判定无偏好
      return null;
    }
    throw new Error('LLM response has no JSON object');
  } catch (e: any) {
    console.warn('[note-preferences] LLM extraction failed, falling back to keywords:', e?.message);
    const prefs = extractPreferencesByKeywords(refinementPrompt);
    if (Object.keys(prefs).length === 0) return null;
    return { subject: fallbackSubject, preferences: prefs };
  }
}

/**
 * 将 subject_preferences 统一为学科分层结构。
 * 旧平铺结构（值为 string/number/boolean）归入 "通用" 层；已是分层的原样保留。
 */
export function normalizeSubjectPreferences(raw: any): Record<string, Record<string, any>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const layered: Record<string, Record<string, any>> = {};
  const flat: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      layered[key] = value as Record<string, any>;
    } else {
      flat[key] = value;
    }
  }
  if (Object.keys(flat).length > 0) {
    layered[GENERAL_SUBJECT] = { ...flat, ...(layered[GENERAL_SUBJECT] || {}) };
  }
  return layered;
}

/** 按学科 key 合并新偏好，返回可写回 subject_preferences 的分层对象 */
export function mergeSubjectPreferences(
  raw: any,
  subject: string,
  preferences: Record<string, any>,
): Record<string, Record<string, any>> {
  const layered = normalizeSubjectPreferences(raw);
  const key = subject && subject.trim() ? subject.trim() : GENERAL_SUBJECT;
  layered[key] = { ...(layered[key] || {}), ...preferences };
  return layered;
}

/**
 * 读取端：把 subject_preferences 渲染成 prompt 文本。
 * 经 normalize 同时兼容旧平铺结构和新分层结构。
 */
export function formatSubjectPreferencesForPrompt(raw: any): string {
  const layered = normalizeSubjectPreferences(raw);
  const subjects = Object.keys(layered);
  if (subjects.length === 0) return '无';
  return subjects
    .map((subject) => {
      const kv = Object.entries(layered[subject])
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('、');
      return `${subject}：${kv}`;
    })
    .join('\n');
}
