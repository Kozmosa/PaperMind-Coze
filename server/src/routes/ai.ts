import { Router } from 'express';
import type { Request, Response } from 'express';
import { anthropic, DEFAULT_MODEL } from '../config/ai.js';
import { getSupabaseClient } from '../storage/database/supabase-client.js';

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
        systemPrompt = await buildTutorPrompt(context);
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
 */
router.post('/tutor', async (req: Request, res: Response) => {
  try {
    const { message, context } = req.body;
    if (!message) {
      return res.status(400).json({ error: '缺少 message 参数' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    const systemPrompt = await buildTutorPrompt(context);

    // 先收集完整回复，再解析 citations
    let fullContent = '';

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullContent += event.delta.text;
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    // 流结束后，提取 citations 并发送元数据
    const citations = extractCitations(fullContent, context);

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

// 提取 citations 的辅助函数
function extractCitations(answer: string, context?: any): any[] {
  const citations: any[] = [];

  if (context?.nodeIds?.length && context?.nodeIds.length > 0) {
    for (const nodeId of context.nodeIds) {
      citations.push({
        type: 'node',
        nodeId: nodeId,
        label: `知识节点 ${nodeId}`
      });
    }
  }

  if (context?.fileContents?.length && context.fileContents.length > 0) {
    for (const fc of context.fileContents) {
      citations.push({
        type: 'file',
        draftId: fc.draft_id,
        fileName: fc.file_name || '未知文件',
        snippet: fc.extracted_text?.substring(0, 100) + '...',
        page: fc.page_number
      });
    }
  }

  return citations;
}

/**
 * POST /api/v1/ai/knowledge-builder
 * knowledge_builder 专用 - 辅助构建知识节点（一次性输出 Papercore/Tags/Relations）
 */
router.post('/knowledge-builder', async (req: Request, res: Response) => {
  try {
    const { rawContent } = req.body;
    if (!rawContent) {
      return res.status(400).json({ error: '缺少原始内容' });
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

现有知识图谱节点：${nodesCtx}

请根据用户输入的原始内容，输出：
PAPERCORE: [简洁的知识核概]
TAGS: [标签1], [标签2]
RELATIONS: 分析该节点在图谱中的关系位置`;

    const stream = anthropic.messages.stream({
      model: DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: rawContent }],
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
 * Body: { draft_ids?: number[], field: 'papercore'|'tags'|'relations'|'short_name', current_content?: string }
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
      case 'relations':
        systemPrompt = `你是知识图谱分析助手，根据文件内容和现有知识图谱，推荐该节点的关系。
现有知识图谱节点：
${nodesList}

文件内容：${fileText || current_content || '(无文件内容)'}

请分析并输出JSON格式：
{
  "prerequisite": [相关节点ID数组，前置知识],
  "subsequent": [相关节点ID数组，后置知识],
  "related": [相关节点ID数组]
}
只输出JSON，不要解释，不要markdown格式。`;
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
3. 分析知识点之间的关联关系

现有知识图谱：${JSON.stringify(nodes || [])}

回答格式：
每个回答包含建议的 Papercore、TAGS 和关系分析。回答专业清晰。`;
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

async function buildTutorPrompt(context?: any): Promise<string> {
  let knowledgeContext = '';
  let fileContentsContext = '';

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

      // 获取关联的文件内容
      const allDraftIds = nodes
        .filter((n: any) => n.attached_draft_ids && n.attached_draft_ids.length > 0)
        .flatMap((n: any) => n.attached_draft_ids);

      if (allDraftIds.length > 0) {
        const { data: fileContents } = await client
          .from('file_contents')
          .select('draft_id, extracted_text, page_number')
          .in('draft_id', allDraftIds.slice(0, 20));

        if (fileContents && fileContents.length > 0) {
          const { data: drafts } = await client
            .from('draft_pool')
            .select('id, file_name, file_url')
            .in('id', allDraftIds.slice(0, 20));

          const draftMap: Record<number, any> = {};
          (drafts || []).forEach((d: any) => { draftMap[d.id] = d; });

          const fileDetails = fileContents.map((fc: any) => {
            const draft = draftMap[fc.draft_id] || {};
            const pageInfo = fc.page_number ? `[第${fc.page_number}页]` : '';
            return `${pageInfo}「${draft.file_name || '未知文件'}」: ${(fc.extracted_text || '').substring(0, 300)}`;
          });

          fileContentsContext = `\n\n相关文件内容：\n${fileDetails.join('\n---\n')}`;
        }
      }
    }
  } else {
    // 默认加载全部知识节点供 tutor 检索
    const { data: nodes } = await client
      .from('knowledge_nodes')
      .select('id, papercore, tags, short_name, attached_draft_ids')
      .order('created_at', { ascending: false })
      .limit(100);

    if (nodes && nodes.length > 0) {
      const nodeList = nodes.map((n: any) =>
        `[${n.short_name || '节点' + n.id}] ${n.papercore || '(暂无概述)'} 标签:${(n.tags || []).join(',')}`
      ).join('\n');
      knowledgeContext = `【知识库节点 (${nodes.length}个)】\n${nodeList}`;

      // 获取关联的文件内容
      const allDraftIds = nodes
        .filter((n: any) => n.attached_draft_ids && n.attached_draft_ids.length > 0)
        .flatMap((n: any) => n.attached_draft_ids);

      if (allDraftIds.length > 0) {
        const { data: fileContents } = await client
          .from('file_contents')
          .select('draft_id, extracted_text, page_number')
          .in('draft_id', allDraftIds.slice(0, 20));

        if (fileContents && fileContents.length > 0) {
          const { data: drafts } = await client
            .from('draft_pool')
            .select('id, file_name, file_url')
            .in('id', allDraftIds.slice(0, 20));

          const draftMap: Record<number, any> = {};
          (drafts || []).forEach((d: any) => { draftMap[d.id] = d; });

          const fileDetails = fileContents.map((fc: any) => {
            const draft = draftMap[fc.draft_id] || {};
            const pageInfo = fc.page_number ? `[第${fc.page_number}页]` : '';
            return `${pageInfo}「${draft.file_name || '未知文件'}」: ${(fc.extracted_text || '').substring(0, 300)}`;
          });

          fileContentsContext = `\n\n相关文件内容：\n${fileDetails.join('\n---\n')}`;
        }
      }
    }
  }

  if (!knowledgeContext) {
    return `你是智能导师 tutor。

知识库中尚未找到与该问题直接相关的内容。

⚠️ 请先告知用户"知识库中没有相应内容"，然后用你的常识给出解答，最后询问用户是否需要将解答补充进知识库。

回答要求：条理清晰、有具体示例、可给出后续学习方向。`;
  }

  return `你是智能导师 tutor，基于以下知识库内容回答用户的问题。

${knowledgeContext}${fileContentsContext}

⚠️ 重要要求：
1. 回答必须简洁有条理，不要重复相同内容
2. 如果问题涉及知识库中的内容，引用对应节点名称给出详细解答
3. 如果问题不在知识库范围内，用你的常识回答，并询问用户是否需要将解答补充进知识库
4. 提供具体示例
5. 引用知识库时标注来源节点名称（short_name）
6. 如果涉及文件内容，可引用文件名和页码
7. 给出后续学习建议
8. 回答完后，在消息末尾添加一行引用来源，格式：「引用来源：节点名称1、节点名称2」`;
}

async function buildReflectionPrompt(context?: any): Promise<string> {
  let logsContext = '';
  let pastReflections = '';
  let nodeActivity = '';

  if (context?.userId) {
    const { data: logs } = await client
      .from('paper_problem_logs')
      .select('*')
      .eq('user_id', context.userId)
      .order('created_at', { ascending: false })
      .limit(20);
    if (logs && logs.length > 0) logsContext = `问题解决记录：${JSON.stringify(logs)}`;

    const { data: refs } = await client
      .from('reflections')
      .select('*')
      .eq('user_id', context.userId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (refs && refs.length > 0) pastReflections = `往期反思：${JSON.stringify(refs)}`;

    const { data: nodes } = await client
      .from('knowledge_nodes')
      .select('id, papercore, created_at')
      .eq('user_id', context.userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (nodes && nodes.length > 0) nodeActivity = `知识节点活动：${JSON.stringify(nodes)}`;
  }

  return `你是学习反思助手 Reflection_mind。

分析用户近期学习行为，生成包含以下4个维度的反思报告：

${logsContext || '暂无问题记录。'}
${pastReflections || '暂无往期反思。'}
${nodeActivity || '暂无知识节点活动。'}

请生成：
1. 📋 **近日学习行为** - 学习内容与节奏
2. 🏆 **攻克问题报告** - 成功解决问题
3. 🧠 **思维模式总结** - 优势与改进点
4. 💡 **学习建议** - 具体可操作建议

风格：鼓励、建设性、有洞察力。`;
}

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

export default router;
