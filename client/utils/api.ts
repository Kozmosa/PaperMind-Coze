import { createFormDataFile } from './index';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 'http://localhost:9091';
const SESSION_KEY = '@papermind_session';

async function getSessionToken(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(SESSION_KEY);
    if (stored) {
      const session = JSON.parse(stored);
      return session.token || null;
    }
  } catch {}
  return null;
}

async function request<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T }> {
  const url = `${BASE_URL}/api/v1${endpoint}`;
  const token = await getSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['x-session'] = token;
  }
  const response = await fetch(url, {
    headers,
    ...options,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`API Error: ${response.status} - ${errorBody}`);
  }

  return response.json();
}

/**
 * 上传文件（multipart/form-data）
 * 返回: { fileKey, fileUrl, fileName, draftId, extracted }
 */
async function uploadFile(fileUri: string, fileName: string, mimeType: string) {
  const fileObj = await createFormDataFile(fileUri, fileName, mimeType);
  const formData = new FormData();
  formData.append('file', fileObj as any);

  const url = `${BASE_URL}/api/v1/upload`;
  const token = await getSessionToken();
  const headers: Record<string, string> = {};
  if (token) headers['x-session'] = token;
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
    headers,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Upload Error: ${response.status} - ${errorBody}`);
  }

  return response.json();
}

export const api = {
  // 文件上传
  uploadFile: (uri: string, name: string, mime: string) => uploadFile(uri, name, mime),

  // 文件内容检索
  getFileContents: (draftId: number) => request<any[]>(`/file-contents/${draftId}`),
  searchFileContents: (keyword: string, draftIds?: number[]) =>
    request<any[]>('/file-contents/search', {
      method: 'POST',
      body: JSON.stringify({ keyword, draft_ids: draftIds }),
    }),

  // Knowledge Nodes
  getKnowledgeNodes: () => request<any[]>('/knowledge-nodes'),
  getKnowledgeNode: (id: number) => request<any>(`/knowledge-nodes/${id}`),
  createKnowledgeNode: (data: any) =>
    request<any>('/knowledge-nodes', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateKnowledgeNode: (id: number, data: any) =>
    request<any>(`/knowledge-nodes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteKnowledgeNode: (id: number) =>
    request<any>(`/knowledge-nodes/${id}`, { method: 'DELETE' }),

  // Draft Pool
  getDrafts: () => request<any[]>('/draft-pool'),
  createDraft: (data: any) =>
    request<any>('/draft-pool', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteDraft: (id: number) =>
    request<any>(`/draft-pool/${id}`, { method: 'DELETE' }),
  updateDraftStatus: (id: number, data: any) =>
    request<any>(`/draft-pool/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Stickynotes
  getStickynotes: (visibility?: string) =>
    request<any[]>(`/stickynotes${visibility ? `?visibility=${visibility}` : ''}`),
  createStickynote: (data: any) =>
    request<any>('/stickynotes', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteStickynote: (id: number) =>
    request<any>(`/stickynotes/${id}`, { method: 'DELETE' }),

  // Forums
  getForums: () => request<any[]>('/forums'),
  createForum: (data: any) =>
    request<any>('/forums', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getForumPosts: (forumId: number) =>
    request<any[]>(`/forums/${forumId}/posts`),
  createForumPost: (data: { forum_id: number; title: string; content: string; author_name?: string }) =>
    request<any>(`/forums/${data.forum_id}/posts`, {
      method: 'POST',
      body: JSON.stringify({
        forum_id: data.forum_id,
        title: data.title,
        content: data.content,
        author_name: data.author_name,
      }),
    }),

  // Papernote Style
  getPapernoteStyle: () => request<any>('/papernote-style'),
  createPapernoteStyle: (data: any) =>
    request<any>('/papernote-style', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  updatePapernoteStyle: (data: any) =>
    request<any>('/papernote-style', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Problem Logs
  getProblemLogs: () => request<any[]>('/problem-logs'),
  createProblemLog: (data: any) =>
    request<any>('/problem-logs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteProblemLog: (id: number) =>
    request<any>(`/problem-logs/${id}`, { method: 'DELETE' }),

  // Reflections
  getReflections: () => request<any[]>('/reflections'),
  getReflection: (id: number) => request<any>(`/reflections/${id}`),
  createReflection: (data: any) =>
    request<any>('/reflections', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // AI Suggest (SSE streaming, returns promise that resolves with full text)
  suggest: (field: string, draft_ids?: number[], current_content?: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const url = `${BASE_URL}/api/v1/ai/suggest`;
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', 'application/json');
      let fullContent = '';
      xhr.onprogress = () => {
        const lines = xhr.responseText.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              resolve(fullContent.trim());
              xhr.abort();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                fullContent += parsed.content;
              }
            } catch {}
          }
        }
      };
      xhr.onload = () => {
        if (xhr.status === 200 && !fullContent) {
          resolve('');
        } else if (xhr.status !== 200) {
          reject(new Error(`Suggest failed: ${xhr.status}`));
        } else {
          resolve(fullContent.trim());
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(JSON.stringify({ field, draft_ids, current_content }));
    });
  },

  // AI Note Helper - 生成笔记内容（流式）
  generateNote: async (nodeContext: {
    nodeId: number;
    papercore?: string;
    tags?: string[];
    relations?: any;
    userId?: string;
  }): Promise<string> => {
    const url = `${BASE_URL}/api/v1/ai/note-helper`;
    const token = await getSessionToken();
    console.log('api.generateNote: calling API', { nodeId: nodeContext.nodeId, papercore: nodeContext.papercore });
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-session': token } : {}),
        },
        body: JSON.stringify({
          nodeId: String(nodeContext.nodeId),
          papercore: nodeContext.papercore || '',
          tags: nodeContext.tags || [],
          relations: nodeContext.relations || {},
        }),
      });
      console.log('api.generateNote: response status', response.status);

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      // 使用文本模式读取响应
      const text = await response.text();
      
      // 解析SSE格式的响应
      let fullContent = '';
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            break;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.content) {
              fullContent += parsed.content;
            }
          } catch {}
        }
      }
      
      return fullContent.trim() || text;
    } catch (error) {
      console.error('generateNote error:', error);
      throw error;
    }
  },

  // Study Notes (学习纪要)
  getStudyNotes: () => request<any[]>('/study-notes'),
  createStudyNote: (data: any) =>
    request<any>('/study-notes', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateStudyNote: (id: string, data: any) =>
    request<any>(`/study-notes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteStudyNote: (id: string) =>
    request<any>(`/study-notes/${id}`, { method: 'DELETE' }),

  // Materials (资料)
  getMaterials: () => request<any[]>('/materials'),
  getMaterialFileContent: (id: string) => request<any>(`/materials/${id}/file-content`),
  createMaterial: (data: any) =>
    request<any>('/materials', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateMaterial: (id: string, data: any) =>
    request<any>(`/materials/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteMaterial: (id: string) =>
    request<any>(`/materials/${id}`, { method: 'DELETE' }),

  // Problem Solving Logs (问题解答日志)
  getProblemSolvingLogs: () => request<any[]>('/problem-solving-logs'),
  createProblemSolvingLog: (data: any) =>
    request<any>('/problem-solving-logs', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getProblemSolvingStats: (days?: number) =>
    request<any>(`/problem-solving-logs/stats${days ? `?days=${days}` : ''}`),

  // Chat Sessions (聊天会话)
  getChatSessions: () => request<any[]>('/chat-sessions'),
  createChatSession: (data: { title: string }) =>
    request<any>('/chat-sessions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getChatSessionMessages: (sessionId: string) =>
    request<any[]>(`/chat-sessions/${sessionId}/messages`),

  // Knowledge Builder
  triggerKnowledgeBuilder: () =>
    request<any>('/knowledge-builder/trigger', { method: 'POST' }),
  reprocessMaterial: (id: string) =>
    request<any>('/knowledge-builder/reprocess-material', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  // Knowledge Graph Data (study_notes + materials based)
  getGraphData: () => request<any>('/knowledge-builder/graph-data'),
  getTagDocuments: (tag: string) =>
    request<any[]>(`/knowledge-builder/tag-documents?tag=${encodeURIComponent(tag)}`),
  rebuildAllTags: () => request<any>('/knowledge-builder/rebuild-all', { method: 'POST' }),

  // Control Center
  markViewed: (type: 'study_note' | 'material', id: string) =>
    request<any>('/control-center/mark-viewed', {
      method: 'POST',
      body: JSON.stringify({ type, id }),
    }),

  // Get combined recent records (study_notes + materials)
  getRecentRecords: () => request<any[]>('/control-center/recent-records'),

  // Note Helper — SSE 流式生成笔记
  generateNoteStream: (
    sourceIds: Array<{ id: string; type: 'study_note' | 'material' }>,
    onChunk: (chunk: string) => void,
    onCitations: (citations: any[]) => void,
    onPreferencesExtracted?: (prefs: any) => void,
    signal?: { aborted: boolean },
  ): Promise<string> => {
    return new Promise(async (resolve, reject) => {
      try {
        const url = `${BASE_URL}/api/v1/ai/generate-note`;
        const token = await getSessionToken();
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (token) xhr.setRequestHeader('x-session', token);

        let lastIndex = 0;
        xhr.onprogress = () => {
          if (signal?.aborted) {
            xhr.abort();
            resolve('');
            return;
          }
          const newText = xhr.responseText.substring(lastIndex);
          lastIndex = xhr.responseText.length;
          const lines = newText.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') return;
              try {
                const parsed = JSON.parse(data);
                if (parsed.content) {
                  onChunk(parsed.content);
                }
                if (parsed.citations) {
                  onCitations(parsed.citations);
                }
                if (parsed.error) {
                  reject(new Error(parsed.error));
                }
              } catch {}
            }
          }
        };
        xhr.onload = () => {
          if (xhr.status === 200) {
            resolve('');
          } else {
            reject(new Error(`Generate failed: ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(JSON.stringify({ sourceIds }));
      } catch (e) {
        reject(e);
      }
    });
  },

  // Note Helper — SSE 流式修正笔记
  refineNoteStream: (
    currentNote: string,
    refinementPrompt: string,
    sourceIds: Array<{ id: string; type: 'study_note' | 'material' }>,
    onChunk: (chunk: string) => void,
    onPreferencesExtracted?: (prefs: any) => void,
    signal?: { aborted: boolean },
  ): Promise<string> => {
    return new Promise(async (resolve, reject) => {
      try {
        const url = `${BASE_URL}/api/v1/ai/refine-note`;
        const token = await getSessionToken();
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (token) xhr.setRequestHeader('x-session', token);

        let lastIndex = 0;
        xhr.onprogress = () => {
          if (signal?.aborted) {
            xhr.abort();
            resolve('');
            return;
          }
          const newText = xhr.responseText.substring(lastIndex);
          lastIndex = xhr.responseText.length;
          const lines = newText.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') return;
              try {
                const parsed = JSON.parse(data);
                if (parsed.content) {
                  onChunk(parsed.content);
                }
                if (parsed.preferences_extracted && onPreferencesExtracted) {
                  onPreferencesExtracted(parsed.preferences_extracted);
                }
                if (parsed.error) {
                  reject(new Error(parsed.error));
                }
              } catch {}
            }
          }
        };
        xhr.onload = () => {
          if (xhr.status === 200) {
            resolve('');
          } else {
            reject(new Error(`Refine failed: ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(JSON.stringify({ currentNote, refinementPrompt, sourceIds }));
      } catch (e) {
        reject(e);
      }
    });
  },

  // Get a single study note by ID
  getStudyNote: (id: string) => request<any>(`/study-notes/${id}`),

  // Get source file content for sidebar preview
  getSourceFileContent: async (id: string, type: 'study_note' | 'material') => {
    if (type === 'study_note') {
      return request<any>(`/study-notes/${id}`);
    }
    return request<any>(`/materials/${id}/file-content`);
  },

  // Suggest relations for a new knowledge node
  suggestRelations: (papercore: string, tags?: string[], topK?: number) =>
    request<{ suggestions: Array<{ nodeId: number; short_name: string; papercore: string; tags: string[]; relation_type: string; score: number }> }>(
      '/ai/suggest-relations',
      { method: 'POST', body: JSON.stringify({ papercore, tags, topK }) }
    ),
};
