import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Modal,
  FlatList,
  Alert,
  Image,
} from 'react-native';
import { useCallback, useState, useRef, useEffect } from 'react';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Screen } from '@/components/layout/Screen';
import MarkdownRenderer from '@/components/markdown/MarkdownRenderer';
import { api } from '@/utils/api';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  timestamp: number;
  imageUri?: string;
};

type Citation = {
  file_url: string;
  file_name: string;
  snippet: string;
  page: number | null;
};

type ChatSession = {
  id: string;
  title: string;
  lastMessage: string;
  lastTime: number;
};

type KnowledgeNode = {
  id: number;
  short_name: string;
  papercore: string;
};

const AGENTS = [
  {
    id: 'tutor',
    name: '智能导师',
    icon: 'book',
    color: '#6C63FF',
    description: '知识问答与学习辅导',
  },
];

export default function ChatScreen() {
  const router = useSafeRouter();
  const scrollRef = useRef<ScrollView>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState('tutor');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);

  // 文件上传相关
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<{ uri: string; name: string } | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [knowledgeNodes, setKnowledgeNodes] = useState<KnowledgeNode[]>([]);

  const currentSessionId = useRef<string | null>(null);
  const fullContentRef = useRef<string>('');
  const citationsRef = useRef<any[]>([]);

  useFocusEffect(
    useCallback(() => {
      loadSessions();
      loadKnowledgeNodes();
    }, [])
  );

  const loadSessions = async () => {
    try {
      const res = await api.getChatSessions();
      setSessions(res.data || []);
    } catch (e) {
      console.error('Failed to load sessions', e);
    }
  };

  const loadKnowledgeNodes = async () => {
    try {
      const res = await api.getKnowledgeNodes();
      setKnowledgeNodes(res.data || []);
    } catch (e) {
      console.error('Failed to load nodes', e);
    }
  };

  const loadSessionMessages = async (sessionId: string) => {
    try {
      const res = await api.getChatSessionMessages(sessionId);
      const msgs = (res.data || []).map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        citations: m.citations || [],
        timestamp: new Date(m.createdAt).getTime(),
      }));
      setMessages(msgs);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 100);
    } catch (e) {
      console.error('Failed to load messages', e);
    }
  };

  const saveSession = async (firstMessage: string) => {
    try {
      const res = await api.createChatSession({ title: firstMessage.slice(0, 50) });
      currentSessionId.current = res.data.id;
      setSessions((prev) => [{ ...res.data, lastMessage: firstMessage, lastTime: Date.now() }, ...prev]);
    } catch (e) {
      console.error('Failed to save session', e);
    }
  };

  const handleSubmit = async () => {
    if (!input.trim() || loading) return;

    // Image URI to store for displaying in bubble
    const imageUri = uploadFile?.uri || null;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      timestamp: Date.now(),
      imageUri: imageUri || undefined,
    };

    // Reset citations before sending
    citationsRef.current = [];

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    fullContentRef.current = '';

    if (!currentSessionId.current) {
      await saveSession(userMsg.content);
    }

    try {
      // 构建上下文
      const context: any = {};
      if (selectedNodeId) {
        context.nodeIds = [selectedNodeId];
      }
      if (uploadFile) {
        // 判断是否为图片，是则编码为 base64
        const isImage = uploadFile.uri.match(/\.(jpg|jpeg|png|gif|webp|bmp)($|\?)/i) ||
                        uploadFile.name.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i);

        if (isImage) {
          try {
            const base64 = await FileSystem.readAsStringAsync(uploadFile.uri, {
              encoding: FileSystem.EncodingType.Base64,
            });
            const ext = (uploadFile.name.split('.').pop() || 'jpeg').toLowerCase();
            const mimeMap: Record<string, string> = {
              jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
              gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
            };
            context.imageBase64 = base64;
            context.mediaType = mimeMap[ext] || 'image/jpeg';
            context.imageFileName = uploadFile.name;
          } catch (e) {
            console.warn('Failed to encode image as base64:', e);
          }
        }

        // 仍然上传文件到服务端存档
        try {
          const uploadRes = await api.uploadFile(uploadFile.uri, uploadFile.name, 'application/octet-stream');
          context.draftId = uploadRes.draftId;
        } catch (e) {
          console.warn('File upload failed (non-blocking):', e);
        }
        setUploadFile(null);
      }

      // 流式请求 - tutor 使用专用端点返回 citations
      const apiEndpoint = selectedAgent === 'tutor'
        ? `${process.env.EXPO_PUBLIC_BACKEND_BASE_URL}/api/v1/ai/tutor`
        : `${process.env.EXPO_PUBLIC_BACKEND_BASE_URL}/api/v1/ai/chat`;

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiEndpoint);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.setRequestHeader('x-session', 'temp-session');

        xhr.onprogress = () => {
          const text = xhr.responseText;
          const lines = text.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                resolve();
                return;
              }
              if (data.startsWith('{')) {
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content !== undefined && parsed.content !== '') {
                    fullContentRef.current += parsed.content;
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.role === 'assistant') {
                        return [...prev.slice(0, -1), { ...last, content: fullContentRef.current, citations: citationsRef.current }];
                      } else {
                        return [...prev, {
                          id: 'assistant-' + Date.now(),
                          role: 'assistant' as const,
                          content: fullContentRef.current,
                          citations: citationsRef.current,
                          timestamp: Date.now(),
                        }];
                      }
                    });
                    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
                  }
                  // 收集 citations
                  if (parsed.citations && Array.isArray(parsed.citations)) {
                    citationsRef.current = [...citationsRef.current, ...parsed.citations];
                  }
                } catch {}
              }
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

        xhr.send(JSON.stringify({
          message: userMsg.content,
          agent: selectedAgent,
          context,
          sessionId: currentSessionId.current,
        }));
      });

      // 保存用户消息和 AI 回复到数据库
      if (currentSessionId.current) {
        try {
          await api.saveChatMessage(currentSessionId.current, {
            role: 'user',
            content: userMsg.content,
          });
          await api.saveChatMessage(currentSessionId.current, {
            role: 'assistant',
            content: fullContentRef.current,
            citations: citationsRef.current,
          });
        } catch (e) {
          console.warn('Failed to save chat messages to DB:', e);
        }
      }
    } catch (e: any) {
      setMessages((prev) => [...prev, {
        id: 'error-' + Date.now(),
        role: 'assistant',
        content: `抱歉，发生了错误：${e.message}`,
        timestamp: Date.now(),
      }]);
    } finally {
      setLoading(false);
    }
  };

  // "我明白了！"功能 - 记录问题解决日志
  const handleUnderstood = async () => {
    if (messages.length < 2) {
      Alert.alert('提示', '请先进行对话后再标记');
      return;
    }

    const lastQa = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    if (lastQa.length < 2) return;

    const question = lastQa[lastQa.length - 2].content;
    const answer = lastQa[lastQa.length - 1].content;
    const citations = lastQa[lastQa.length - 1].citations || [];

    try {
      await api.createProblemSolvingLog({
        question,
        answer,
        steps: '',
        related_knowledge_node_ids: selectedNodeId ? [selectedNodeId] : [],
        citation_snippets: citations,
      });

      Alert.alert('已记录', '问题解答已记录到日志，可点击底部的"问题日志"查看');
    } catch (e) {
      console.error('Failed to save problem solving log', e);
    }
  };

  const handleSelectFile = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('权限不足', '请允许访问相册');
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
        setShowUploadModal(false);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const renderCitation = (citation: any, idx: number) => {
    // Image citation
    if (citation.type === 'image') {
      return (
        <View key={idx} style={{ backgroundColor: '#FFF8E6', borderRadius: 12, padding: 12, marginTop: 8, borderWidth: 1, borderColor: '#F5D88A' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Feather name="image" size={14} color="#D97706" />
            <Text style={{ marginLeft: 6, color: '#2D3436', fontWeight: '600', fontSize: 13, flex: 1 }} numberOfLines={1}>
              {citation.label || citation.fileName || citation.title || '用户上传的图片'}
            </Text>
          </View>
          <Text style={{ color: '#636E72', fontSize: 13, lineHeight: 20 }}>
            {citation.snippet || 'AI 已分析图片内容'}
          </Text>
        </View>
      );
    }

    // Knowledge node citation (purple)
    if (citation.type === 'knowledge_node' || citation.type === 'node') {
      const hasPapercore = !!citation.papercore;
      return (
        <View key={idx} style={{ backgroundColor: '#EEF0FF', borderRadius: 12, padding: 12, marginTop: 8, borderLeftWidth: 3, borderLeftColor: '#6C63FF' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Feather name="book-open" size={14} color="#6C63FF" />
            <Text style={{ marginLeft: 6, color: '#2D3436', fontWeight: '600', fontSize: 13, flex: 1 }} numberOfLines={1}>
              {citation.title || citation.label || `知识节点 ${citation.sourceId || citation.nodeId}`}
            </Text>
            <View style={{ backgroundColor: '#6C63FF20', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: '#6C63FF', fontSize: 10, fontWeight: '600' }}>知识节点</Text>
            </View>
          </View>
          {hasPapercore && (
            <Text style={{ color: '#636E72', fontSize: 13, lineHeight: 20 }} numberOfLines={3}>
              {citation.papercore}
            </Text>
          )}
          {!hasPapercore && (
            <Text style={{ color: '#636E72', fontSize: 13, lineHeight: 20 }}>
              关联的知识库节点
            </Text>
          )}
        </View>
      );
    }

    // Study note citation (green)
    if (citation.type === 'study_note') {
      return (
        <View key={idx} style={{ backgroundColor: '#E8F5E9', borderRadius: 12, padding: 12, marginTop: 8, borderLeftWidth: 3, borderLeftColor: '#00B894' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Feather name="edit-3" size={14} color="#00B894" />
            <Text style={{ marginLeft: 6, color: '#2D3436', fontWeight: '600', fontSize: 13, flex: 1 }} numberOfLines={1}>
              {citation.title || citation.fileName || `学习纪要`}
            </Text>
            <View style={{ backgroundColor: '#00B89420', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: '#00B894', fontSize: 10, fontWeight: '600' }}>学习纪要</Text>
            </View>
          </View>
          {citation.papercore ? (
            <Text style={{ color: '#636E72', fontSize: 13, lineHeight: 20 }} numberOfLines={3}>
              {citation.papercore}
            </Text>
          ) : null}
          {citation.tags?.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, gap: 4 }}>
              {(citation.tags || []).slice(0, 5).map((t: string, i: number) => (
                <Text key={i} style={{ color: '#00B894', fontSize: 11, backgroundColor: '#00B89414', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
                  #{t}
                </Text>
              ))}
            </View>
          )}
        </View>
      );
    }

    // Material citation (orange)
    if (citation.type === 'material') {
      return (
        <View key={idx} style={{ backgroundColor: '#FFF3E0', borderRadius: 12, padding: 12, marginTop: 8, borderLeftWidth: 3, borderLeftColor: '#FF9F43' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Feather name="file-text" size={14} color="#FF9F43" />
            <Text style={{ marginLeft: 6, color: '#2D3436', fontWeight: '600', fontSize: 13, flex: 1 }} numberOfLines={1}>
              {citation.title || citation.fileName || `学习资料`}
            </Text>
            <View style={{ backgroundColor: '#FF9F4320', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: '#FF9F43', fontSize: 10, fontWeight: '600' }}>资料</Text>
            </View>
          </View>
          {citation.papercore ? (
            <Text style={{ color: '#636E72', fontSize: 13, lineHeight: 20 }} numberOfLines={3}>
              {citation.papercore}
            </Text>
          ) : null}
          {citation.tags?.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, gap: 4 }}>
              {(citation.tags || []).slice(0, 5).map((t: string, i: number) => (
                <Text key={i} style={{ color: '#FF9F43', fontSize: 11, backgroundColor: '#FF9F4314', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
                  #{t}
                </Text>
              ))}
            </View>
          )}
        </View>
      );
    }

    // File content citation (gray with page number)
    if (citation.type === 'file_content' || citation.type === 'file') {
      const pageNum = citation.pageNumber || citation.page;
      return (
        <View key={idx} style={{ backgroundColor: '#F0F0F3', borderRadius: 12, padding: 12, marginTop: 8, borderLeftWidth: 3, borderLeftColor: pageNum ? '#0984E3' : '#636E72' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Feather name="file-text" size={14} color={pageNum ? '#0984E3' : '#636E72'} />
            <Text style={{ marginLeft: 6, color: '#2D3436', fontWeight: '600', fontSize: 13, flex: 1 }} numberOfLines={1}>
              {citation.title || citation.fileName || citation.file_name || '未知文件'}
            </Text>
            {pageNum ? (
              <View style={{ backgroundColor: '#0984E320', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ color: '#0984E3', fontSize: 11, fontWeight: '600' }}>第{pageNum}页</Text>
              </View>
            ) : (
              <View style={{ backgroundColor: '#636E7220', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                <Text style={{ color: '#636E72', fontSize: 10, fontWeight: '600' }}>原文</Text>
              </View>
            )}
          </View>
          <Text style={{ color: '#636E72', fontSize: 13, lineHeight: 20 }} numberOfLines={4}>
            {citation.snippet || '关联的原文内容'}
          </Text>
        </View>
      );
    }

    // Unknown / fallback
    return (
      <View key={idx} style={{ backgroundColor: '#F0F0F3', borderRadius: 12, padding: 12, marginTop: 8 }}>
        <Text style={{ color: '#636E72', fontSize: 13 }}>
          {citation.title || citation.label || '引用来源'}
        </Text>
      </View>
    );
  };

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'top']}>
      <View style={{ flex: 1, flexDirection: 'row' }}>
        {/* History Panel (left side, slides in) */}
        {showHistoryPanel && (
          <View style={{ width: 260, backgroundColor: '#FFF', borderRightWidth: 1, borderRightColor: '#F0F0F3', paddingTop: 12 }}>
            <View style={{ paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#F0F0F3' }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436' }}>历史对话</Text>
            </View>
            <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
              {sessions.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: '#F0F0F3' }}
                  onPress={() => {
                    currentSessionId.current = s.id;
                    loadSessionMessages(s.id);
                    setShowHistoryPanel(false);
                  }}
                >
                  <Text style={{ fontWeight: '600', color: '#2D3436', fontSize: 14 }} numberOfLines={2}>
                    {s.title}
                  </Text>
                  <Text style={{ color: '#636E72', fontSize: 12, marginTop: 4 }}>
                    {new Date(s.lastTime).toLocaleDateString()}
                  </Text>
                </TouchableOpacity>
              ))}
              {sessions.length === 0 && (
                <Text style={{ textAlign: 'center', color: '#B2BEC3', marginTop: 40, fontSize: 14 }}>
                  暂无历史对话
                </Text>
              )}
            </ScrollView>
          </View>
        )}

        {/* Main chat area */}
        <View style={{ flex: 1 }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#F0F0F3' }}>
            <TouchableOpacity onPress={() => setShowHistoryPanel(!showHistoryPanel)} style={{ marginRight: 12 }}>
              <Feather name={showHistoryPanel ? 'menu' : 'menu'} size={22} color="#2D3436" />
            </TouchableOpacity>

            {/* Agent selector */}
            <View style={{ flex: 1 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {AGENTS.map((agent) => (
                <TouchableOpacity
                  key={agent.id}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    borderRadius: 20,
                    backgroundColor: selectedAgent === agent.id ? agent.color : '#F0F0F3',
                    marginRight: 8,
                  }}
                  onPress={() => setSelectedAgent(agent.id)}
                >
                  <Text style={{ color: selectedAgent === agent.id ? '#FFF' : '#636E72', fontWeight: '600', fontSize: 14 }}>
                    {agent.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            </View>

            <TouchableOpacity
              style={{ marginRight: 12 }}
              onPress={() => router.push('/knowledge-builder')}
            >
              <Feather name="plus-square" size={22} color="#6C63FF" />
            </TouchableOpacity>
            <TouchableOpacity
              style={{ marginLeft: 0 }}
              onPress={() => router.push('/problem-solving-logs')}
            >
              <Feather name="list" size={22} color="#2D3436" />
            </TouchableOpacity>
          </View>

          {/* Upload indicator */}
          {uploadFile && (
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#FFF8E6' }}>
              <Feather name="paperclip" size={14} color="#D97706" />
              <Text style={{ marginLeft: 6, color: '#D97706', fontSize: 13, flex: 1 }} numberOfLines={1}>
                已附加: {uploadFile.name}
              </Text>
              <TouchableOpacity onPress={() => setUploadFile(null)}>
                <Feather name="x" size={14} color="#D97706" />
              </TouchableOpacity>
            </View>
          )}

          {/* Messages */}
          <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 12 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {messages.length === 0 && (
              <View style={{ alignItems: 'center', paddingTop: 60 }}>
                <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#6C63FF1A', justifyContent: 'center', alignItems: 'center', marginBottom: 16 }}>
                  <Feather name="book" size={28} color="#6C63FF" />
                </View>
                <Text style={{ fontSize: 20, fontWeight: '700', color: '#2D3436', marginBottom: 8 }}>
                  智能导师
                </Text>
                <Text style={{ fontSize: 14, color: '#636E72', textAlign: 'center', maxWidth: 280 }}>
                  基于你的知识库回答问题，可以上传文件或选择知识节点作为上下文
                </Text>
              </View>
            )}

            {messages.map((msg) => (
              <View key={msg.id} style={{ marginBottom: 16 }}>
                {msg.role === 'user' ? (
                  <View style={{ alignItems: 'flex-end' }}>
                    {msg.imageUri && (
                      <Image
                        source={{ uri: msg.imageUri }}
                        style={{ width: 200, height: 150, borderRadius: 12, marginBottom: 6, resizeMode: 'contain' }}
                      />
                    )}
                    <View style={{ backgroundColor: '#6C63FF', borderRadius: 18, borderBottomRightRadius: 4, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '80%' }}>
                      <Text style={{ color: '#FFF', fontSize: 15, lineHeight: 22 }}>{msg.content}</Text>
                    </View>
                  </View>
                ) : (
                  <View style={{ alignItems: 'flex-start' }}>
                    <View style={{ backgroundColor: '#F0F0F3', borderRadius: 18, borderBottomLeftRadius: 4, paddingHorizontal: 16, paddingVertical: 10, maxWidth: '100%' }}>
                      {msg.content ? (
                        <MarkdownRenderer content={msg.content} />
                      ) : (
                        <Text style={{ color: '#636E72', fontSize: 14 }}>...</Text>
                      )}
                    </View>
                    {citationsRef.current && citationsRef.current.length > 0 && (
                      <View style={{ marginTop: 8, maxWidth: '85%' }}>
                        <Text style={{ fontSize: 12, color: '#6C63FF', fontWeight: '700', marginBottom: 4 }}>引用资料</Text>
                        {citationsRef.current.map((c, i) => renderCitation(c, i))}
                      </View>
                    )}
                  </View>
                )}
              </View>
            ))}

            {loading && (
              <View style={{ alignItems: 'flex-start', marginBottom: 16 }}>
                <View style={{ backgroundColor: '#F0F0F3', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12 }}>
                  <Text style={{ color: '#636E72' }}>思考中...</Text>
                </View>
              </View>
            )}
          </ScrollView>

          {/* "I understand" button */}
          {messages.length >= 2 && messages[messages.length - 1].role === 'assistant' && (
            <TouchableOpacity
              style={{ marginHorizontal: 16, marginBottom: 8, backgroundColor: '#00B8941A', borderRadius: 12, paddingVertical: 10, alignItems: 'center' }}
              onPress={handleUnderstood}
            >
              <Text style={{ color: '#00B894', fontWeight: '700', fontSize: 14 }}>我明白了！记录到问题日志</Text>
            </TouchableOpacity>
          )}

          {/* Input area */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: '#F0F0F3' }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
              {/* Upload button */}
              <TouchableOpacity
                style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#F0F0F3', justifyContent: 'center', alignItems: 'center' }}
                onPress={() => setShowUploadModal(true)}
              >
                <Feather name="upload" size={18} color="#6C63FF" />
              </TouchableOpacity>

              {/* Knowledge node selector */}
              <TouchableOpacity
                style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: selectedNodeId ? '#6C63FF' : '#F0F0F3', justifyContent: 'center', alignItems: 'center' }}
                onPress={() => {
                  if (selectedNodeId) {
                    setSelectedNodeId(null);
                  } else {
                    Alert.alert(
                      '选择知识节点',
                      '选择要关联的知识节点（当前对话上下文）',
                      [
                        { text: '不选择', onPress: () => { /* skip selection */ } },
                        ...knowledgeNodes.map((n) => ({
                          text: n.short_name || `节点${n.id}`,
                          onPress: () => setSelectedNodeId(n.id),
                        })),
                      ]
                    );
                  }
                }}
              >
                <Feather name="book-open" size={18} color={selectedNodeId ? '#FFF' : '#6C63FF'} />
              </TouchableOpacity>

              {/* Text input */}
              <TextInput
                style={{ flex: 1, backgroundColor: '#F0F0F3', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, color: '#2D3436', maxHeight: 100 }}
                placeholder="输入问题..."
                placeholderTextColor="#B2BEC3"
                value={input}
                onChangeText={setInput}
                multiline
                textAlignVertical="center"
              />

              {/* Send button */}
              <TouchableOpacity
                style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: input.trim() && !loading ? '#6C63FF' : '#F0F0F3', justifyContent: 'center', alignItems: 'center' }}
                onPress={handleSubmit}
                disabled={!input.trim() || loading}
              >
                <Feather name="send" size={18} color={input.trim() && !loading ? '#FFF' : '#B2BEC3'} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>

      {/* Upload Modal */}
      <Modal visible={showUploadModal} transparent animationType="fade">
        <TouchableOpacity
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' }}
          onPress={() => setShowUploadModal(false)}
        >
          <View style={{ backgroundColor: '#FFF', borderRadius: 20, padding: 24, width: 300 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436', marginBottom: 16 }}>上传文件</Text>

            {/* 从相册选择图片 */}
            <TouchableOpacity
              style={{ backgroundColor: '#F0F0F3', borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 12 }}
              onPress={() => {
                setShowUploadModal(false);
                handleSelectFile();
              }}
            >
              <Feather name="image" size={32} color="#6C63FF" />
              <Text style={{ marginTop: 8, color: '#6C63FF', fontWeight: '600' }}>从相册选择图片</Text>
              <Text style={{ marginTop: 4, color: '#B2BEC3', fontSize: 12 }}>手写笔记、公式推导、教材截图</Text>
            </TouchableOpacity>

            {/* 关联知识节点（可选） */}
            <TouchableOpacity
              style={{ backgroundColor: '#F5F3FF', borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 12 }}
              onPress={() => {
                setShowUploadModal(false);
                if (knowledgeNodes.length === 0) {
                  Alert.alert('提示', '暂无知识节点，请先在知识库中创建节点');
                  return;
                }
                Alert.alert(
                  '关联知识节点',
                  `选择要关联的知识节点（当前选中: ${selectedNodeId ? knowledgeNodes.find(n => n.id === selectedNodeId)?.short_name || `节点${selectedNodeId}` : '无'}）`,
                  [
                    { text: '取消关联', onPress: () => setSelectedNodeId(null) },
                    ...knowledgeNodes.slice(0, 20).map((n) => ({
                      text: `${n.short_name || `节点${n.id}`} ${selectedNodeId === n.id ? '✓' : ''}`,
                      onPress: () => setSelectedNodeId(n.id),
                    })),
                  ]
                );
              }}
            >
              <Feather name="book-open" size={28} color="#7C6FF7" />
              <Text style={{ marginTop: 6, color: '#7C6FF7', fontWeight: '600' }}>关联知识节点</Text>
              <Text style={{ marginTop: 2, color: '#B2BEC3', fontSize: 12 }}>
                {selectedNodeId ? `已选: ${knowledgeNodes.find(n => n.id === selectedNodeId)?.short_name || `节点${selectedNodeId}`}` : '可选，提高回答准确性'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setShowUploadModal(false)}>
              <Text style={{ textAlign: 'center', color: '#636E72', fontSize: 14 }}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </Screen>
  );
}
