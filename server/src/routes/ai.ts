import { Router } from 'express';
import type { Request, Response } from 'express';
import { anthropic, DEFAULT_MODEL } from '../config/ai.js';
import { getSupabaseClient } from '../storage/database/supabase-client.js';
import { unifiedVectorIndex } from '../utils/unified-vector-index.js';

const router = Router();
const client = getSupabaseClient();

/**
 * POST /api/v1/ai/chat
 * 统一的 AI 智能体对话接口（SSE 流式输出）
 * Body: { agent: string, message: string, context?: any }
 * agent: 'knowledge_builder' | 'note_helper' | 'tutor' | 'reflection_mind'
 */
router.post('/chat', async (req: Request, res: Response) => {
  try {
    const { agent, message, context } = req.body;
    if (!agent || !message) {
      return res.status(400).json({ error: '缺少 agent 或 message 参数' });
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    let systemPrompt = '';

    switch (agent) {
      case 'knowledge_builder':
        systemPrompt = await buildKnowledgeBuilderPrompt(context);
        break;
      case 'note_helper':
        systemPrompt = await buildNoteHelperPrompt(context);
        break;
      case 'tutor':
        // /chat endpoint only needs the prompt string, no searchResults needed
        ({ systemPrompt } = await buildTutorPrompt(context, message));
        break;
      case 'reflection_mind':
        systemPrompt = await buildReflectionPrompt(context);
        break;
      default:
        systemPrompt = '你是一个智能学习助手，帮助用户解决学习问题。回答简洁专业。';
    }

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('AI Chat Error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || 'AI 服务异常' });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

/**
 * POST /api/v1/ai/tutor
 * Tutor 专用接口 - 返回结构化 JSON（包含答案和引用）
 * Body: { message: string, context?: any }
 * 支持图片：context: { imageBase64: string, mediaType: string }
 */
router.post('/tutor', async (req: Request, res: Response) => {
  try {
    const { message, context } = req.body;
    if (!message) {
      return res.status(400).json({ error: '缺少 message 参数' });
    }

    const imageBase64 = context?.imageBase64 || null;
    const mediaType = context?.mediaType || 'image/jpeg';

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    const hasImage = !!imageBase64;
    const { systemPrompt, searchResults } = await buildTutorPrompt(context, message, hasImage);

    // 构建消息：有图片时用 multipart content blocks，否则纯文本
    let messages: any[];
    if (hasImage) {
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: message }
        ]
      }];
    } else {
      messages = [{ role: 'user', content: message }];
    }

    // 先收集完整回复，再解析 citations
    let fullContent = '';

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullContent += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    // 流结束后，提取 citations 并发送元数据
    const citations = await extractCitations(fullContent, context, searchResults);

    res.write(`data: ${JSON.stringify({
      content: '',
      done: true,
      citations: citations
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('Tutor Error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || 'Tutor 服务异常' });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ── Citation type ─────────────────────────────────────────────────
interface Citation {
  type: 'knowledge_node' | 'study_note' | 'material' | 'file_content' | 'image';
  sourceId: string | number;
  sourceType: string;
  title: string;
  papercore?: string;
  tags?: string[];
  pageNumber?: number | null;
  snippet?: string;
  fileName?: string;
  fileUrl?: string;
  draftId?: number;
  label?: string;     // display fallback
}

// 提取 citations 的辅助函数
async function extractCitations(
  answer: string,
  context?: any,
  searchResults?: any[],
): Promise<Citation[]> {
  const citations: Citation[] = [];

  // 用户上传的图片引用
  if (context?.imageBase64) {
    citations.push({
      type: 'image',
      sourceId: context.imageFileName || 'uploaded_image',
      sourceType: 'image',
      title: context.imageFileName || '上传的图片',
      fileName: context.imageFileName || '上传的图片',
      label: '用户上传的图片',
      snippet: '图片已由 AI 视觉分析处理',
    });
  }

  // ── From search results (unified vector index) ───────────────
  if (searchResults && searchResults.length > 0) {
    for (const r of searchResults) {
      const c: Citation = {
        type: r.sourceType,
        sourceId: r.sourceId,
        sourceType: r.sourceType,
        title: r.title,
        papercore: r.papercore,
        tags: r.tags,
        pageNumber: r.pageNumber || null,
        snippet: r.sourceType === 'file_content'
          ? r.papercore // already snipped in index
          : r.papercore?.substring(0, 200),
        fileName: r.fileName,
        draftId: r.draftId,
      };
      citations.push(c);
    }
  }

  // ── Explicitly selected nodes ────────────────────────────────
  if (context?.nodeIds?.length && context?.nodeIds.length > 0) {
    const existingNodeIds = new Set(
      citations.filter(c => c.type === 'knowledge_node').map(c => c.sourceId)
    );
    for (const nodeId of context.nodeIds) {
      if (!existingNodeIds.has(nodeId)) {
        citations.push({
          type: 'knowledge_node',
          sourceId: nodeId,
          sourceType: 'knowledge_node',
          title: `知识节点 ${nodeId}`,
          label: `知识节点 ${nodeId}`,
        });
      }
    }
  }

  // ── Fallback: explicit file contents from context ────────────
  if (context?.fileContents?.length && context.fileContents.length > 0) {
    const existingFcIds = new Set(
      citations.filter(c => c.type === 'file_content').map(c => c.sourceId)
    );
    for (const fc of context.fileContents) {
      if (!existingFcIds.has(fc.draft_id)) {
        citations.push({
          type: 'file_content',
          sourceId: fc.draft_id,
          sourceType: 'file_content',
          title: fc.file_name || `文件片段`,
          fileName: fc.file_name || '未知文件',
          pageNumber: fc.page_number,
          snippet: fc.extracted_text?.substring(0, 200),
          draftId: fc.draft_id,
        });
      }
    }
  }

  // ── User-uploaded file (context.draftId) ─────────────────────
  if (context?.draftId) {
    const hasDraft = citations.some(c =>
      (c.type === 'file_content' || c.type === 'material') && c.draftId === context.draftId
    );
    if (!hasDraft) {
      try {
        const { data: draft } = await client
          .from('draft_pool')
          .select('id, file_name, file_url')
          .eq('id', context.draftId)
          .single();

        if (draft) {
          citations.push({
            type: 'file_content',
            sourceId: draft.id,
            sourceType: 'file_content',
            title: draft.file_name || '上传文件',
            fileName: draft.file_name || '上传文件',
            snippet: '用户当前上传的参考文件',
            draftId: draft.id,
          });
        }
      } catch {
        // 非关键，静默忽略
      }
    }
  }

  return citations;
}

/**
 * POST /api/v1/ai/knowledge-builder
 * knowledge_builder 专用 - 辅助构建知识节点（一次性输出 Papercore/Tags/Relations）
 * Body: { rawContent?: string, imageBase64?: string, mediaType?: string }
 * 支持图片输入（截图/手写笔记 → 提取概念生成 Papercore + Tags）
 */
router.post('/knowledge-builder', async (req: Request, res: Response) => {
  try {
    const { rawContent, imageBase64, mediaType } = req.body;
    const hasImage = !!imageBase64;

    if (!rawContent && !hasImage) {
      return res.status(400).json({ error: '缺少内容（rawContent 或 imageBase64）' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    // 获取现有知识图谱节点列表
    const { data: existingNodes } = await client
      .from('knowledge_nodes')
      .select('id, papercore, tags')
      .order('created_at', { ascending: false })
      .limit(50);

    const nodesCtx = JSON.stringify(existingNodes || []);

    const systemPrompt = `你是知识构建助手 knowledge_builder，帮助用户构建知识节点：
${hasImage ? '\n🖼️ 用户上传了一张图片（可能是公式截图、手写笔记、教材页面等）。请仔细分析图片内容，识别其中的公式、概念和关键术语。' : ''}
现有知识图谱节点：${nodesCtx}

请根据用户输入的内容，输出：
PAPERCORE: [简洁的知识核概，30-80字，用第一人称表达理解]
TAGS: [标签1], [标签2], [标签3]

注意：
- Papercore 是个人化的理解总结，不是原文照抄
- Tags 以 # 开头，3-5 个

直接输出以下格式：
PAPERCORE: <内容>
TAGS: <标签列表>`;

    // 构建消息：有图片时用 multipart content blocks
    let messages: any[];
    if (hasImage) {
      const contentBlocks: any[] = [];
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 }
      });
      if (rawContent) {
        contentBlocks.push({ type: 'text', text: rawContent });
      } else {
        contentBlocks.push({ type: 'text', text: '请分析这张图片，提取其中的知识概念，生成 Papercore 和 Tags。' });
      }
      messages = [{ role: 'user', content: contentBlocks }];
    } else {
      messages = [{ role: 'user', content: rawContent }];
    }

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('Knowledge Builder Error:', error);
    if (!res.headersSent) return res.status(500).json({ error: error.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

/**
 * POST /api/v1/ai/suggest
 * AI 自动填写字段（Papercore/Tags/Relations/ShortName）
 * Body: { draft_ids?: number[], field: 'papercore'|'tags'|'short_name', current_content?: string }
 */
router.post('/suggest', async (req: Request, res: Response) => {
  try {
    const { draft_ids, field, current_content } = req.body;
    if (!field) {
      return res.status(400).json({ error: '缺少 field 参数' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    // 获取文件内容
    let fileText = '';
    if (draft_ids && Array.isArray(draft_ids) && draft_ids.length > 0) {
      const { data: fileContents } = await client
        .from('file_contents')
        .select('extracted_text, page_number')
        .in('draft_id', draft_ids.slice(0, 5));

      if (fileContents && fileContents.length > 0) {
        fileText = fileContents.map((fc: any) =>
          `[第${fc.page_number || '?'}页] ${fc.extracted_text || ''}`
        ).join('\n\n');
      }
    }

    // 获取现有知识图谱节点
    const { data: existingNodes } = await client
      .from('knowledge_nodes')
      .select('id, papercore, tags, short_name')
      .order('created_at', { ascending: false })
      .limit(50);

    const nodesList = (existingNodes || []).map((n: any) =>
      `ID:${n.id} | 名称:${n.short_name || n.papercore?.substring(0, 15) || '无'} | 标签:${(n.tags || []).join(',')}`
    ).join('\n');

    // 构建 prompt
    let systemPrompt = '';
    switch (field) {
      case 'short_name':
        systemPrompt = `你是知识整理助手，根据以下内容生成一个简短的图谱显示名称（2-8个字）。
文件内容：${fileText || current_content || '(无文件内容)'}
直接输出名称，不要解释，不要加引号，不要加任何前缀。只输出2-8个字的中文名称。`;
        break;
      case 'papercore':
        systemPrompt = `你是知识整理助手，根据文件内容生成一句话知识核概（Papercore）。
要求：30-80字，用第一人称表达，体现个人理解，不要照抄原文。
文件内容：${fileText || current_content || '(无文件内容)'}
直接输出Papercore，不要前缀，不要解释。`;
        break;
      case 'tags':
        systemPrompt = `你是知识整理助手，从文件内容中提取3-5个标签。
要求：标签以#开头，如 #课堂笔记 #核心概念 #重要公式
文件内容：${fileText || current_content || '(无文件内容)'}
直接输出标签列表，不要解释，不要JSON格式。`;
        break;
      default:
        systemPrompt = '请根据内容给出建议。';
    }

    const userContent = fileText || current_content || '请根据系统指令给出建议';

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    let fullContent = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullContent += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('Suggest Error:', error);
    if (!res.headersSent) return res.status(500).json({ error: error.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

/**
 * POST /api/v1/ai/suggest-relations
 * 根据 Papercore 语义搜索相关节点，并用 LLM 分类关系类型
 * Body: { papercore: string, tags?: string[], topK?: number }
 * Response: JSON { suggestions: [{ nodeId, short_name, papercore, relation_type, score }] }
 */
router.post('/suggest-relations', async (req: Request, res: Response) => {
  try {
    const { papercore, tags, topK = 10 } = req.body;
    if (!papercore) {
      return res.status(400).json({ error: '缺少 papercore 参数' });
    }

    // 1. 语义搜索
    const searchResults = await unifiedVectorIndex.search(papercore, topK, 0.3);

    if (searchResults.length === 0) {
      return res.json({ suggestions: [] });
    }

    // 2. 用 LLM 分类关系类型
    const candidates = searchResults.map((r: any) =>
      `[ID:${r.sourceId}] 名称:${r.title || ''} Papercore:${r.papercore?.substring(0, 80)} 标签:${(r.tags || []).join(',')}`
    ).join('\n');

    const systemPrompt = `你是知识图谱关系分类助手。给定一个新的知识节点，判断它与现有节点的关系类型。

新节点的 Papercore: "${papercore}"${tags?.length ? `\n新节点标签: ${tags.join(', ')}` : ''}

现有候选节点：
${candidates}

请对以上每个候选节点，判断关系类型。关系类型定义：
- prerequisite: 前置知识（需要先学这个节点才能理解新节点）
- related: 相关知识（同一层次的关联概念）
- parent: 上层概念（新节点是这个概念的子集/特例）

返回严格的 JSON 数组格式，不要包含任何其他文字：
[
  {"nodeId": <数字ID>, "relation_type": "prerequisite|related|parent"},
  ...
]

如果某个节点不属于以上任何类型，不要包含它。最多返回5个关系。`;

    const msg = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: '请分析并返回 JSON 数组。' }],
    });

    // 3. 解析 LLM 响应
    let classified: Array<{ nodeId: number; relation_type: string }> = [];
    try {
      const text = (msg.content[0] as any)?.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        classified = JSON.parse(jsonMatch[0]);
      }
    } catch (parseErr) {
      console.warn('[suggest-relations] LLM JSON parse failed, falling back to vector-only');
    }

    // 4. 合并语义分数和 LLM 分类
    const scoreMap: Record<number, number> = {};
    searchResults.forEach((r: any) => { scoreMap[r.sourceId] = r.score; });

    const suggestions = classified
      .filter((c: any) => scoreMap[c.nodeId] !== undefined)
      .map((c: any) => {
        const sr: any = searchResults.find((r: any) => r.sourceId === c.nodeId)!;
        return {
          nodeId: c.nodeId,
          short_name: sr.title,
          papercore: sr.papercore,
          tags: sr.tags,
          relation_type: c.relation_type,
          score: Math.round(scoreMap[c.nodeId] * 100) / 100,
        };
      });

    // 5. 没有被 LLM 分类的，标记为 related（降级处理）
    const classifiedIds = new Set(classified.map((c: any) => c.nodeId));
    for (const sr of searchResults) {
      if (!classifiedIds.has(sr.sourceId as number)) {
        suggestions.push({
          nodeId: sr.sourceId,
          short_name: sr.title,
          papercore: sr.papercore,
          tags: sr.tags,
          relation_type: 'related',
          score: Math.round(sr.score * 100) / 100,
        });
      }
    }

    res.json({ suggestions: suggestions.slice(0, 8) });
  } catch (error: any) {
    console.error('SuggestRelations Error:', error);
    res.status(500).json({ error: error.message || '关系建议失败' });
  }
});

async function buildKnowledgeBuilderPrompt(context?: any): Promise<string> {
  const { data: nodes } = await client
    .from('knowledge_nodes')
    .select('id, papercore, tags')
    .order('created_at', { ascending: false })
    .limit(50);

  return `你是知识构建助手 knowledge_builder，帮助用户构建知识节点。

核心职责：
1. 辅助撰写高质量的知识节点梗概（Papercore）
2. 提取和优化标签

现有知识图谱：${JSON.stringify(nodes || [])}

回答格式：
每个回答包含建议的 Papercore 和 TAGS。回答专业清晰。`;
}

async function buildNoteHelperPrompt(context?: any): Promise<string> {
  let stylePreference = '';
  if (context?.userId) {
    const { data: styles } = await client
      .from('papernote_style')
      .select('*')
      .eq('user_id', context.userId)
      .limit(1);

    if (styles && styles.length > 0) {
      stylePreference = `用户笔记偏好：
- 总偏好：${styles[0].general_preference || '无'}
- 学科偏好：${JSON.stringify(styles[0].subject_preferences || {})}`;
    }
  }

  // 知识节点内容
  const nodeContent = context?.papercore
    ? `【知识节点核心理解】\n${context.papercore}\n\n【标签】\n${(context.tags || []).map((t: string) => '#' + t).join(' ')}`
    : '';

  return `你是笔记助手 note_helper，根据知识节点内容和用户笔记偏好生成结构化笔记。

${nodeContent || '【知识节点信息】\n暂无节点内容，请基于一般知识生成标准笔记模板。'}

${stylePreference || '尚无明确的笔记偏好记录，请用通用高质量笔记格式。'}

笔记要求：
- 标题层级组织
- 重点用**加粗**
- 列表/表格辅助
- 包含关键概念、原理、示例
- 结尾有简短总结

请直接生成笔记内容，不需要询问用户。`;
}

async function buildTutorPrompt(
  context?: any,
  userMessage?: string,
  hasImage?: boolean,
): Promise<{ systemPrompt: string; searchResults?: any[] }> {
  let knowledgeContext = '';
  let fileContentsContext = '';
  let allFileContents: any[] = []; // for citations
  let searchResults: any[] = [];   // returned for extractCitations

  // ── Layer 1: User-specified knowledge nodes ──────────────────
  if (context?.nodeIds && Array.isArray(context.nodeIds) && context.nodeIds.length > 0) {
    const { data: nodes } = await client
      .from('knowledge_nodes')
      .select('id, papercore, tags, short_name, attached_draft_ids')
      .in('id', context.nodeIds);

    if (nodes && nodes.length > 0) {
      const nodeList = nodes.map((n: any) =>
        `[${n.short_name || '节点' + n.id}] ${n.papercore || '(暂无概述)'} 标签:${(n.tags || []).join(',')}`
      ).join('\n');
      knowledgeContext = `【相关知识节点 (${nodes.length}个)】\n${nodeList}`;

      // Build searchResults-like entries for citations
      searchResults = nodes.map((n: any) => ({
        sourceType: 'knowledge_node' as const,
        sourceId: n.id,
        title: n.short_name || `节点${n.id}`,
        papercore: n.papercore,
        tags: n.tags || [],
      }));

      const allDraftIds = nodes
        .filter((n: any) => n.attached_draft_ids && n.attached_draft_ids.length > 0)
        .flatMap((n: any) => n.attached_draft_ids);

      if (allDraftIds.length > 0) {
        ({ fileContentsContext, allFileContents } = await loadFileContents(allDraftIds));
      }
    }
  }

  // ── Layer 2: Unified semantic + tag search ───────────────────
  if (!knowledgeContext && userMessage) {
    searchResults = await unifiedVectorIndex.search(userMessage, 10, 0.3);

    if (searchResults.length > 0) {
      // Collect knowledge_node IDs for DB lookup
      const knResults = searchResults.filter(r => r.sourceType === 'knowledge_node');
      const snResults = searchResults.filter(r => r.sourceType === 'study_note');
      const mResults = searchResults.filter(r => r.sourceType === 'material');
      const fcResults = searchResults.filter(r => r.sourceType === 'file_content');

      const contextLines: string[] = [];

      // ── knowledge_nodes ────────────────────────────────────
      if (knResults.length > 0) {
        const nodeIds = knResults.map(r => r.sourceId);
        const { data: nodes } = await client
          .from('knowledge_nodes')
          .select('id, papercore, tags, short_name, attached_draft_ids')
          .in('id', nodeIds);

        if (nodes && nodes.length > 0) {
          const scoreMap: Record<number, number> = {};
          knResults.forEach(r => { scoreMap[r.sourceId as number] = r.score; });
          const sortedNodes = nodes.sort((a: any, b: any) =>
            (scoreMap[b.id] || 0) - (scoreMap[a.id] || 0));

          const nodeLines = sortedNodes.map((n: any) =>
            `[知识节点: ${n.short_name || '节点' + n.id}] ${n.papercore || ''} 标签:${(n.tags || []).join(',')} [相关度: ${(scoreMap[n.id] || 0).toFixed(2)}]`
          );
          contextLines.push(`【知识节点 (${sortedNodes.length}个)】\n${nodeLines.join('\n')}`);

          // Fetch attached file contents
          const allDraftIds = sortedNodes
            .filter((n: any) => n.attached_draft_ids && n.attached_draft_ids.length > 0)
            .flatMap((n: any) => n.attached_draft_ids);
          if (allDraftIds.length > 0) {
            const { fileContentsContext: knFcCtx } = await loadFileContents(allDraftIds);
            if (knFcCtx) contextLines.push(knFcCtx);
          }
        }
      }

      // ── study_notes ────────────────────────────────────────
      if (snResults.length > 0) {
        const snIds = snResults.map(r => r.sourceId);
        const { data: notes } = await client
          .from('study_notes')
          .select('id, papercore, tags, title, content')
          .in('id', snIds);

        if (notes && notes.length > 0) {
          const noteLines = notes.map((n: any) =>
            `[学习纪要: ${n.title || '纪要' + n.id}] ${n.papercore || ''} 标签:${(n.tags || []).join(',')}\n内容摘要: ${(n.content || '').substring(0, 200)}`
          );
          contextLines.push(`\n【学习纪要 (${notes.length}个)】\n${noteLines.join('\n---\n')}`);
        }
      }

      // ── materials ──────────────────────────────────────────
      if (mResults.length > 0) {
        const mIds = mResults.map(r => r.sourceId);
        const { data: materials } = await client
          .from('materials')
          .select('id, papercore, tags, name, file_path')
          .in('id', mIds);

        if (materials && materials.length > 0) {
          const matLines = materials.map((m: any) =>
            `[资料: ${m.name || '资料' + m.id}] ${m.papercore || ''} 标签:${(m.tags || []).join(',')}`
          );
          contextLines.push(`\n【学习资料 (${materials.length}个)】\n${matLines.join('\n')}`);
        }
      }

      // ── file_contents ──────────────────────────────────────
      if (fcResults.length > 0) {
        const fcLines = fcResults.map((r, i) => {
          const pageInfo = r.pageNumber ? `第${r.pageNumber}页` : '';
          const fName = r.fileName || '文件';
          return `[原文片段: ${fName} ${pageInfo}] ${r.papercore?.substring(0, 300) || ''}`;
        });
        contextLines.push(`\n【原文片段 (${fcResults.length}个)】\n${fcLines.join('\n---\n')}`);
      }

      knowledgeContext = contextLines.join('\n');

      // Collect file_contents for citation metadata
      for (const r of fcResults) {
        allFileContents.push({
          draft_id: r.draftId,
          extracted_text: r.papercore,
          page_number: r.pageNumber,
          file_name: r.fileName,
        });
      }
    }
  }

  // ── Layer 3: Fallback — load all recent from three tables ──
  if (!knowledgeContext) {
    const contextLines: string[] = [];

    // knowledge_nodes
    const { data: nodes } = await client
      .from('knowledge_nodes')
      .select('id, papercore, tags, short_name')
      .order('created_at', { ascending: false })
      .limit(100);

    if (nodes && nodes.length > 0) {
      const nodeList = nodes.map((n: any) =>
        `[${n.short_name || '节点' + n.id}] ${n.papercore || '(暂无概述)'} 标签:${(n.tags || []).join(',')}`
      ).join('\n');
      contextLines.push(`【知识库节点 (${nodes.length}个)】\n${nodeList}`);

      searchResults = nodes.map((n: any) => ({
        sourceType: 'knowledge_node' as const,
        sourceId: n.id,
        title: n.short_name || `节点${n.id}`,
        papercore: n.papercore,
        tags: n.tags || [],
      }));
    }

    // study_notes
    const { data: sNotes } = await client
      .from('study_notes')
      .select('id, papercore, tags, title')
      .eq('ai_processed', true)
      .order('created_at', { ascending: false })
      .limit(50);

    if (sNotes && sNotes.length > 0) {
      const snList = sNotes.map((n: any) =>
        `[学习纪要: ${n.title || '纪要' + n.id}] ${n.papercore || ''} 标签:${(n.tags || []).join(',')}`
      ).join('\n');
      contextLines.push(`\n【学习纪要 (${sNotes.length}个)】\n${snList}`);
    }

    // materials
    const { data: mats } = await client
      .from('materials')
      .select('id, papercore, tags, name')
      .eq('ai_processed', true)
      .order('created_at', { ascending: false })
      .limit(50);

    if (mats && mats.length > 0) {
      const mList = mats.map((m: any) =>
        `[资料: ${m.name || '资料' + m.id}] ${m.papercore || ''} 标签:${(m.tags || []).join(',')}`
      ).join('\n');
      contextLines.push(`\n【学习资料 (${mats.length}个)】\n${mList}`);
    }

    knowledgeContext = contextLines.join('\n');
  }

  // ── Image analysis instructions ──────────────────────────────
  const imageInstruction = hasImage
    ? `\n🖼️ 用户上传了一张图片。请仔细分析图片中的内容（文字、公式、图表等）。在回答时：
- 先描述你在图片中看到的内容（公式、推导步骤等）
- 用自然语言标注关键区域，格式：【区域：{位置描述}】（例如"【区域：图片左上角的公式】"、"【区域：第2步到第3步的推导过程】"）
- 将图片内容与知识库中的相关节点关联起来
- 如果图片是手写笔记，尝试识别其中的文字和公式\n`
    : '';

  if (!knowledgeContext) {
    return {
      systemPrompt: `你是智能导师 tutor。
${imageInstruction}
知识库中尚未找到与该问题直接相关的内容。

⚠️ 请先告知用户"知识库中没有相应内容"，然后用你的常识给出解答，最后询问用户是否需要将解答补充进知识库。

回答要求：条理清晰、有具体示例、可给出后续学习方向。`,
      searchResults,
    };
  }

  return {
    systemPrompt: `你是智能导师 tutor，基于以下知识库内容回答用户的问题。
${imageInstruction}
${knowledgeContext}${fileContentsContext}

⚠️ 重要要求：
1. 回答必须简洁有条理，不要重复相同内容
2. 如果问题涉及知识库中的内容，引用对应来源名称给出详细解答
3. 如果问题不在知识库范围内，用你的常识回答，并询问用户是否需要将解答补充进知识库
4. 提供具体示例
5. 引用知识库时标注来源名称，格式：【来源：{名称}】
6. PDF/文件来源请明确引用页码，格式：【来源：{文件名}，第N页】
7. 如需高亮关键原文位置，用「原文...」包裹引用内容
8. 给出后续学习建议
9. 回答完后，在消息末尾添加引用来源汇总，格式：「引用来源：来源名称1、来源名称2」`,
    searchResults,
  };
}

/**
 * Helper: fetch file_contents + draft metadata for a set of draft_ids.
 */
async function loadFileContents(draftIds: number[]): Promise<{
  fileContentsContext: string;
  allFileContents: any[];
}> {
  const { data: fileContents } = await client
    .from('file_contents')
    .select('draft_id, extracted_text, page_number')
    .in('draft_id', draftIds.slice(0, 20));

  if (!fileContents || fileContents.length === 0) {
    return { fileContentsContext: '', allFileContents: [] };
  }

  const { data: drafts } = await client
    .from('draft_pool')
    .select('id, file_name, file_url')
    .in('id', draftIds.slice(0, 20));

  const draftMap: Record<number, any> = {};
  (drafts || []).forEach((d: any) => { draftMap[d.id] = d; });

  const fileDetails = fileContents.map((fc: any) => {
    const draft = draftMap[fc.draft_id] || {};
    const pageInfo = fc.page_number ? `[第${fc.page_number}页]` : '';
    return `${pageInfo}「${draft.file_name || '未知文件'}」: ${(fc.extracted_text || '').substring(0, 300)}`;
  });

  return {
    fileContentsContext: `\n\n相关文件内容：\n${fileDetails.join('\n---\n')}`,
    allFileContents: fileContents.map((fc: any) => ({
      draft_id: fc.draft_id,
      extracted_text: fc.extracted_text,
      page_number: fc.page_number,
      file_name: draftMap[fc.draft_id]?.file_name || '',
    })),
  };
}

async function buildReflectionPrompt(context?: any, period?: string): Promise<string> {
  let logsContext = '';
  let pastReflections = '';
  let nodeActivity = '';
  let qaLogsContext = '';

  // 计算时间范围
  let sinceDate: string | null = null;
  if (period) {
    const days = parseInt(period.replace(/[^0-9]/g, '')) || 7;
    sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  if (context?.userId) {
    // 问题解决记录（按时间过滤）
    let logsQuery = client
      .from('paper_problem_logs')
      .select('*')
      .eq('user_id', context.userId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (sinceDate) logsQuery = logsQuery.gte('created_at', sinceDate);
    const { data: logs } = await logsQuery;
    if (logs && logs.length > 0) logsContext = `问题解决记录（${logs.length}条）：${JSON.stringify(logs)}`;

    // 问答日志（Tutor 对话记录，按时间过滤）
    let qaLogsQuery = client
      .from('problem_solving_logs')
      .select('question, answer, created_at')
      .eq('user_id', context.userId)
      .order('created_at', { ascending: false })
      .limit(30);
    if (sinceDate) qaLogsQuery = qaLogsQuery.gte('created_at', sinceDate);
    const { data: qaLogs } = await qaLogsQuery;
    if (qaLogs && qaLogs.length > 0) qaLogsContext = `问答日志（${qaLogs.length}条）：${JSON.stringify(qaLogs)}`;

    // 往期反思
    const { data: refs } = await client
      .from('reflections')
      .select('*')
      .eq('user_id', context.userId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (refs && refs.length > 0) pastReflections = `往期反思（${refs.length}条）：${JSON.stringify(refs)}`;

    // 知识节点活动（按时间过滤）
    let nodesQuery = client
      .from('knowledge_nodes')
      .select('id, papercore, short_name, tags, created_at')
      .eq('user_id', context.userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (sinceDate) nodesQuery = nodesQuery.gte('created_at', sinceDate);
    const { data: nodes } = await nodesQuery;
    if (nodes && nodes.length > 0) nodeActivity = `知识节点活动（${nodes.length}个）：${JSON.stringify(nodes)}`;
  }

  const periodLabel = period
    ? (period.includes('3') ? '近三天' : period.includes('30') ? '近一个月' : '近一周')
    : '近期';

  return `你是学习反思助手 Reflection_mind。

分析用户${periodLabel}的学习行为，生成包含以下4个维度的反思报告：

${logsContext || '暂无问题记录。'}
${qaLogsContext || '暂无问答日志。'}
${pastReflections || '暂无往期反思。'}
${nodeActivity || '暂无知识节点活动。'}

请生成以下4个部分，严格按格式输出，每个部分以 "## 标题" 开头（两个 # 号加一个空格加标题），各部分之间空一行：

## 学习行为
<分析用户${periodLabel}的学习内容与节奏，200-400字>

## 攻克问题
<总结用户${periodLabel}成功解决的问题，200-400字>

## 思维模式
<分析用户的思维优势与改进点，200-400字>

## 学习建议
<给出具体可操作的学习建议，200-400字>

风格：鼓励、建设性、有洞察力。不要输出任何其他内容（如前言、结语、署名等），直接从 "## 学习行为" 开始输出。`;
}

/**
 * 解析反思报告中的4个 section
 * 期望格式：
 *   ## 学习行为\n<content>\n\n## 攻克问题\n<content>\n\n## 思维模式\n<content>\n\n## 学习建议\n<content>
 */
function parseReflectionSections(text: string): {
  learning_behavior: string;
  challenge_report: string;
  thinking_pattern: string;
  suggestion: string;
} {
  const result = {
    learning_behavior: '',
    challenge_report: '',
    thinking_pattern: '',
    suggestion: '',
  };

  const sectionMap: Record<string, keyof typeof result> = {
    '学习行为': 'learning_behavior',
    '攻克问题': 'challenge_report',
    '思维模式': 'thinking_pattern',
    '学习建议': 'suggestion',
  };

  // 用正则匹配 "## 标题\n内容" 直到下一个 "## " 或文本结束
  const regex = /##\s+(学习行为|攻克问题|思维模式|学习建议)\s*\n([\s\S]*?)(?=\n##\s|\n*$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const title = match[1];
    const content = match[2].trim();
    const key = sectionMap[title];
    if (key && content) {
      result[key] = content;
    }
  }

  return result;
}

/**
 * POST /api/v1/ai/generate-reflection
 * 生成学习反思报告并保存到数据库
 * Body: { period: string }  例如 "3days", "7days", "30days"
 * 返回 SSE 流：{ content: "..." }  ... { done: true, reflection: { id, ... } }  [DONE]
 */
router.post('/generate-reflection', async (req: Request, res: Response) => {
  try {
    const { period } = req.body;
    if (!period) {
      return res.status(400).json({ error: '缺少 period 参数' });
    }

    const userId = (req as any).userId || 'guest';

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    const systemPrompt = await buildReflectionPrompt({ userId }, period);

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: `请根据我的${period.includes('3') ? '近三天' : period.includes('30') ? '近一个月' : '近一周'}的学习数据，生成学习反思报告。` }],
    });

    let fullContent = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullContent += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    // 解析4个section
    const sections = parseReflectionSections(fullContent);

    // 保存到数据库
    const { data: saved, error: saveError } = await client
      .from('reflections')
      .insert({
        learning_behavior: sections.learning_behavior || null,
        challenge_report: sections.challenge_report || null,
        thinking_pattern: sections.thinking_pattern || null,
        suggestion: sections.suggestion || null,
        period,
        user_id: userId,
      })
      .select()
      .single();

    if (saveError) {
      console.error('Failed to save reflection:', saveError);
      res.write(`data: ${JSON.stringify({ error: '保存反思报告失败' })}\n\n`);
    } else if (saved) {
      res.write(`data: ${JSON.stringify({
        done: true,
        reflection: {
          id: saved.id,
          period: saved.period,
          learning_behavior: saved.learning_behavior,
          challenge_report: saved.challenge_report,
          thinking_pattern: saved.thinking_pattern,
          suggestion: saved.suggestion,
          created_at: saved.created_at,
        }
      })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('GenerateReflection Error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || '反思生成失败' });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

/**
 * POST /api/v1/ai/note-helper
 * 根据知识节点信息生成笔记内容
 * Body: { nodeId: string, papercore: string, tags: string[], relations: object }
 */
router.post('/note-helper', async (req: Request, res: Response) => {
  try {
    const { nodeId, papercore, tags, relations } = req.body;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    const context = {
      nodeId,
      papercore: papercore || '',
      tags: tags || [],
      relations: relations || {},
    };

    const systemPrompt = await buildNoteHelperPrompt(context);

    let fullContent = '';

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: '请为这个知识节点生成一份结构化的学习笔记。' }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullContent += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: fullContent })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('NoteHelper Error:', error);
    res.status(500).json({ error: '生成笔记失败' });
  }
});

/**
 * POST /api/v1/ai/generate-note
 * 根据多份源文件（学习纪要+资料）生成结构化笔记（SSE 流式）
 * Body: { sourceIds: Array<{id: string, type: 'study_note' | 'material'}>, userId?: string }
 */
router.post('/generate-note', async (req: Request, res: Response) => {
  try {
    const { sourceIds, userId } = req.body;
    if (!sourceIds || !Array.isArray(sourceIds) || sourceIds.length === 0) {
      return res.status(400).json({ error: '请选择至少一份源文件' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    const uid = userId || (req as any).userId || 'guest';

    // 1. 获取用户笔记偏好
    let stylePreference = '';
    const { data: styles } = await client
      .from('papernote_style')
      .select('*')
      .eq('user_id', uid)
      .limit(1);

    if (styles && styles.length > 0) {
      const st = styles[0];
      stylePreference = `用户笔记偏好：
- 总偏好：${st.general_preference || '无'}
- 学科偏好：${JSON.stringify(st.subject_preferences || {})}`;
    }

    // 2. 获取所有源文件内容
    const sources: { id: string; type: string; title: string; content: string; }[] = [];
    const citations: { index: number; sourceId: string; sourceType: string; fileName: string; }[] = [];
    let citationIndex = 0;

    for (const src of sourceIds) {
      if (src.type === 'study_note') {
        const { data: note } = await client
          .from('study_notes')
          .select('*')
          .eq('id', src.id)
          .single();

        if (note) {
          let content = note.content || '';
          if (note.blocks && Array.isArray(note.blocks)) {
            content = note.blocks
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.content || '')
              .join('\n\n');
          }
          sources.push({
            id: src.id,
            type: 'study_note',
            title: note.title || '学习纪要',
            content: content.substring(0, 3000),
          });
          citationIndex++;
          citations.push({
            index: citationIndex,
            sourceId: src.id,
            sourceType: 'study_note',
            fileName: note.title || '学习纪要',
          });
        }
      } else if (src.type === 'material') {
        const { data: mat } = await client
          .from('materials')
          .select('*')
          .eq('id', src.id)
          .single();

        if (mat) {
          let fileText = '';
          try {
            const { data: fileContents } = await client
              .from('file_contents')
              .select('extracted_text')
              .eq('draft_id', src.id)
              .limit(1);
            if (fileContents && fileContents.length > 0) {
              fileText = (fileContents[0] as any).extracted_text || '';
            }
          } catch {}

          sources.push({
            id: src.id,
            type: 'material',
            title: mat.name || mat.title || '资料',
            content: (mat.papercore || '') + '\n' + fileText.substring(0, 3000),
          });
          citationIndex++;
          citations.push({
            index: citationIndex,
            sourceId: src.id,
            sourceType: 'material',
            fileName: mat.name || '资料',
          });
        }
      }
    }

    if (sources.length === 0) {
      res.write(`data: ${JSON.stringify({ error: '未找到有效的源文件内容' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 3. 构建 prompt
    const sourcesText = sources.map((s, i) =>
      `【来源${i + 1}】${s.title}（${s.type === 'study_note' ? '学习纪要' : '资料'}）\n${s.content}`
    ).join('\n\n---\n\n');

    const systemPrompt = `你是笔记助手 note_helper。根据用户提供的多份学习资料生成一份结构化的综合笔记。

${stylePreference || '尚无明确的笔记偏好记录，请用通用高质量笔记格式。'}

笔记要求：
- 使用标题层级组织（# ## ###）
- 重点用**加粗**标记
- 适当使用列表和表格
- 包含关键概念、原理、示例
- 结尾有简短总结
- 在引用某份源文件内容时，在段落末尾标注引用标记，格式为 [来源:N]（N为来源编号）
- 引用编号必须对应下方的来源编号

${sourcesText}

请直接生成笔记内容。`;

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: '请根据以上所有来源资料，生成一份综合学习笔记。' }],
    });

    let fullContent = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullContent += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    // Post-process: extract context snippets around each [来源:N] marker
    const citationsWithContext = citations.map(cit => {
      const markerPattern = new RegExp(`\\[来源:${cit.index}\\]([^\\[]*)`, 'g');
      let snippet = '';
      // Find text around citation marker — extract surrounding sentence/paragraph
      const idx = fullContent.indexOf(`[来源:${cit.index}]`);
      if (idx >= 0) {
        // Get preceding and following text (up to 80 chars each side)
        const start = Math.max(0, idx - 80);
        const end = Math.min(fullContent.length, idx + `[来源:${cit.index}]`.length + 80);
        snippet = fullContent.slice(start, end).replace(/\n+/g, ' ').trim();
      }
      return { ...cit, highlightText: snippet };
    });

    res.write(`data: ${JSON.stringify({ citations: citationsWithContext, done: true })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error: any) {
    console.error('GenerateNote Error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || '生成笔记失败' });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

/**
 * POST /api/v1/ai/refine-note
 * 根据用户修正指令优化笔记（SSE 流式，含偏好提取）
 * Body: { currentNote: string, refinementPrompt: string, sourceIds?: Array<...>, userId?: string }
 */
router.post('/refine-note', async (req: Request, res: Response) => {
  try {
    const { currentNote, refinementPrompt, sourceIds, userId } = req.body;
    if (!currentNote || !refinementPrompt) {
      return res.status(400).json({ error: '缺少笔记内容或修正指令' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    const uid = userId || (req as any).userId || 'guest';

    // 1. 获取用户偏好
    const { data: styles } = await client
      .from('papernote_style')
      .select('*')
      .eq('user_id', uid)
      .limit(1);

    const existingPrefs = (styles && styles.length > 0)
      ? (styles[0].subject_preferences || {})
      : {};

    // 2. 从修正指令中提取偏好关键词
    const extractedPrefs: Record<string, any> = {};
    const prompt = refinementPrompt.toLowerCase();
    if (prompt.includes('详细') || prompt.includes('展开') || prompt.includes('更多')) extractedPrefs.detail_level = 'high';
    if (prompt.includes('简洁') || prompt.includes('简短') || prompt.includes('概括')) extractedPrefs.detail_level = 'concise';
    if (prompt.includes('表格') || prompt.includes('对比')) extractedPrefs.prefer_tables = true;
    if (prompt.includes('例子') || prompt.includes('示例') || prompt.includes('举例')) extractedPrefs.prefer_examples = true;
    if (prompt.includes('重点') || prompt.includes('突出') || prompt.includes('强调')) extractedPrefs.emphasize_keypoints = true;
    if (prompt.includes('通俗') || prompt.includes('简单') || prompt.includes('易懂')) extractedPrefs.language_style = 'plain';

    // 3. 保存提取的偏好
    if (Object.keys(extractedPrefs).length > 0) {
      const mergedPrefs = { ...existingPrefs, ...extractedPrefs };
      try {
        const { data: existingRecord } = await client
          .from('papernote_style')
          .select('id')
          .eq('user_id', uid)
          .limit(1);

        if (existingRecord && existingRecord.length > 0) {
          await client
            .from('papernote_style')
            .update({
              subject_preferences: mergedPrefs,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingRecord[0].id);
        } else {
          await client
            .from('papernote_style')
            .insert({
              user_id: uid,
              subject_preferences: mergedPrefs,
            });
        }
        res.write(`data: ${JSON.stringify({ preferences_extracted: extractedPrefs })}\n\n`);
      } catch (e) {
        console.error('Failed to save preferences:', e);
      }
    }

    // 4. 构建修正 prompt
    let sourcesContext = '';
    if (sourceIds && Array.isArray(sourceIds) && sourceIds.length > 0) {
      const sourcesTexts: string[] = [];
      for (const src of sourceIds) {
        if (src.type === 'study_note') {
          const { data: note } = await client
            .from('study_notes')
            .select('title, content, blocks')
            .eq('id', src.id)
            .single();
          if (note) {
            let content = note.content || '';
            if (note.blocks && Array.isArray(note.blocks)) {
              content = note.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.content || '').join('\n');
            }
            sourcesTexts.push(`【${note.title || '纪要'}】${content.substring(0, 2000)}`);
          }
        } else if (src.type === 'material') {
          const { data: mat } = await client
            .from('materials')
            .select('name, papercore')
            .eq('id', src.id)
            .single();
          if (mat) {
            sourcesTexts.push(`【${mat.name || '资料'}】${mat.papercore || ''}`);
          }
        }
      }
      if (sourcesTexts.length > 0) {
        sourcesContext = '\n\n原始参考资料：\n' + sourcesTexts.join('\n---\n');
      }
    }

    const systemPrompt = `你是笔记助手 note_helper。用户正在优化一份学习笔记，请根据修正指令对笔记进行修改。

修正指令：${refinementPrompt}

要求：
- 保持笔记的整体结构
- 仅修改需要调整的部分
- 保留原有的引用标记 [来源:N]
- 如果修正指令涉及格式（如表格、列表），按指令调整
- 如果修正指令要求更详细/更简洁，相应地展开或压缩内容

${sourcesContext}

请直接输出修正后的完整笔记，包含所有标题、内容和引用标记。`;

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: `当前笔记：\n\n${currentNote}\n\n请按修正指令修改。` }],
    });

    let fullContent = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullContent += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error: any) {
    console.error('RefineNote Error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: error.message || '修正笔记失败' });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

/**
 * POST /api/v1/ai/refresh-index
 * 重建知识节点向量索引
 */
router.post('/refresh-index', async (_req: Request, res: Response) => {
  try {
    await unifiedVectorIndex.buildIndex();
    res.json({
      success: true,
      nodeCount: unifiedVectorIndex.getRecordCount(),
      ready: unifiedVectorIndex.isReady(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || '索引重建失败' });
  }
});

export default router;
