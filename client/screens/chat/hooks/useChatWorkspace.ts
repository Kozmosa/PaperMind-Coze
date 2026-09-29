import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import Toast from 'react-native-toast-message';
import { useFocusEffect } from 'expo-router';
import { readAsStringAsync } from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { api } from '@/utils/api';
import { BACKEND_BASE_URL } from '@/utils/backend';
import type {
  ChatMessage,
  ChatSession,
  Citation,
  KnowledgeNode,
  UploadFile,
} from '../types';

export function useChatWorkspace() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [knowledgeNodes, setKnowledgeNodes] = useState<KnowledgeNode[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<UploadFile | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);

  const currentSessionId = useRef<string | null>(null);
  const fullContentRef = useRef('');
  const citationsRef = useRef<Citation[]>([]);

  const loadSessions = useCallback(async () => {
    try {
      const res = await api.getChatSessions();
      setSessions(res.data || []);
    } catch (error) {
      console.error('Failed to load sessions', error);
    }
  }, []);

  const loadKnowledgeNodes = useCallback(async () => {
    try {
      const res = await api.getKnowledgeNodes();
      setKnowledgeNodes(res.data || []);
    } catch (error) {
      console.error('Failed to load nodes', error);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadSessions();
      loadKnowledgeNodes();
    }, [loadKnowledgeNodes, loadSessions]),
  );

  const loadSessionMessages = useCallback(async (sessionId: string) => {
    try {
      const res = await api.getChatSessionMessages(sessionId);
      const restored = (res.data || []).map((item: any) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        citations: item.citations || [],
        timestamp: new Date(item.createdAt).getTime(),
      })) as ChatMessage[];

      currentSessionId.current = sessionId;
      setMessages(restored);
      setHistoryOpen(false);
    } catch (error) {
      console.error('Failed to load messages', error);
    }
  }, []);

  const saveSession = useCallback(async (firstMessage: string) => {
    try {
      const res = await api.createChatSession({ title: firstMessage.slice(0, 50) });
      currentSessionId.current = res.data.id;
      setSessions((previous) => [
        { ...res.data, lastMessage: firstMessage, lastTime: Date.now() },
        ...previous,
      ]);
    } catch (error) {
      console.error('Failed to save session', error);
    }
  }, []);

  const startNewSession = useCallback(() => {
    currentSessionId.current = null;
    setMessages([]);
    setInput('');
    setUploadFile(null);
    setSelectedNodeId(null);
    setHistoryOpen(false);
  }, []);

  const submitMessage = useCallback(
    async (rawMessage?: string) => {
      const message = (rawMessage ?? input).trim();
      if (!message || loading) return;

      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: message,
        timestamp: Date.now(),
        imageUri: uploadFile?.uri,
      };

      citationsRef.current = [];
      setMessages((previous) => [...previous, userMessage]);
      setInput('');
      setLoading(true);
      fullContentRef.current = '';

      if (!currentSessionId.current) {
        await saveSession(message);
      }

      try {
        const context: any = {};
        if (selectedNodeId) context.nodeIds = [selectedNodeId];

        if (uploadFile) {
          const isImage =
            uploadFile.uri.match(/\.(jpg|jpeg|png|gif|webp|bmp)($|\?)/i) ||
            uploadFile.name.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i);

          if (isImage) {
            try {
              const base64 = await readAsStringAsync(uploadFile.uri, {
                encoding: 'base64',
              });
              const extension = (uploadFile.name.split('.').pop() || 'jpeg').toLowerCase();
              const mimeMap: Record<string, string> = {
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                png: 'image/png',
                gif: 'image/gif',
                webp: 'image/webp',
                bmp: 'image/bmp',
              };
              context.imageBase64 = base64;
              context.mediaType = mimeMap[extension] || 'image/jpeg';
              context.imageFileName = uploadFile.name;
            } catch (error) {
              console.warn('Failed to encode image as base64:', error);
            }
          }

          try {
            const uploadRes = await api.uploadFile(
              uploadFile.uri,
              uploadFile.name,
              'application/octet-stream',
            );
            context.draftId = uploadRes.draftId;
          } catch (error) {
            console.warn('File upload failed (non-blocking):', error);
          }
          setUploadFile(null);
        }

        const endpoint = `${BACKEND_BASE_URL}/api/v1/ai/tutor`;
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', endpoint);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.setRequestHeader('x-session', 'temp-session');

          xhr.onprogress = () => {
            const lines = xhr.responseText.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6);
              if (data === '[DONE]') {
                resolve();
                return;
              }
              if (!data.startsWith('{')) continue;

              try {
                const parsed = JSON.parse(data);
                if (parsed.content !== undefined && parsed.content !== '') {
                  fullContentRef.current += parsed.content;
                  setMessages((previous) => {
                    const last = previous[previous.length - 1];
                    const nextCitations = citationsRef.current;
                    if (last?.role === 'assistant') {
                      return [
                        ...previous.slice(0, -1),
                        { ...last, content: fullContentRef.current, citations: nextCitations },
                      ];
                    }
                    return [
                      ...previous,
                      {
                        id: `assistant-${Date.now()}`,
                        role: 'assistant' as const,
                        content: fullContentRef.current,
                        citations: nextCitations,
                        timestamp: Date.now(),
                      },
                    ];
                  });
                }
                if (Array.isArray(parsed.citations)) {
                  citationsRef.current = [...citationsRef.current, ...parsed.citations];
                }
              } catch {
                // Ignore malformed SSE fragments.
              }
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 400) {
              reject(new Error('请求失败'));
            } else {
              resolve();
            }
          };
          xhr.onerror = () => reject(new Error('网络错误'));
          xhr.send(
            JSON.stringify({
              message,
              agent: 'tutor',
              context,
              sessionId: currentSessionId.current,
            }),
          );
        });

        if (currentSessionId.current) {
          try {
            await api.saveChatMessage(currentSessionId.current, {
              role: 'user',
              content: message,
            });
            await api.saveChatMessage(currentSessionId.current, {
              role: 'assistant',
              content: fullContentRef.current,
              citations: citationsRef.current,
            });
          } catch (error) {
            console.warn('Failed to save chat messages to DB:', error);
          }
        }
      } catch (error: any) {
        setMessages((previous) => [
          ...previous,
          {
            id: `error-${Date.now()}`,
            role: 'assistant',
            content: `抱歉，发生了错误：${error.message}`,
            timestamp: Date.now(),
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [input, loading, saveSession, selectedNodeId, uploadFile],
  );

  const markUnderstood = useCallback(async () => {
    if (messages.length < 2) {
      Toast.show({ type: 'info', text1: '提示', text2: '请先进行对话后再标记' });
      return;
    }

    const dialogue = messages.filter((item) => item.role === 'user' || item.role === 'assistant');
    if (dialogue.length < 2) return;

    const question = dialogue[dialogue.length - 2].content;
    const answer = dialogue[dialogue.length - 1].content;
    const citations = dialogue[dialogue.length - 1].citations || [];

    try {
      await api.createProblemSolvingLog({
        question,
        answer,
        steps: '',
        related_knowledge_node_ids: selectedNodeId ? [selectedNodeId] : [],
        citation_snippets: citations,
      });
      Toast.show({ type: 'success', text1: '已记录', text2: '问题解答已记录到日志' });
    } catch (error) {
      console.error('Failed to save problem solving log', error);
    }
  }, [messages, selectedNodeId]);

  const selectImage = useCallback(async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Toast.show({ type: 'error', text1: '权限不足', text2: '请允许访问相册' });
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });
      if (!result.canceled && result.assets?.[0]) {
        setUploadFile({
          uri: result.assets[0].uri,
          name: result.assets[0].fileName || 'uploaded_file',
        });
        setUploadDialogOpen(false);
      }
    } catch (error) {
      console.error(error);
    }
  }, []);

  return {
    messages,
    sessions,
    knowledgeNodes,
    input,
    setInput,
    loading,
    historyOpen,
    setHistoryOpen,
    uploadDialogOpen,
    setUploadDialogOpen,
    uploadFile,
    setUploadFile,
    selectedNodeId,
    setSelectedNodeId,
    loadSessionMessages,
    startNewSession,
    submitMessage,
    markUnderstood,
    selectImage,
  };
}
