import { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Screen } from '@/components/layout/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import RNSSE from 'react-native-sse';
import { Ionicons } from '@expo/vector-icons';
import { useCSSVariable } from 'uniwind';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const AGENT_INFO: Record<string, { name: string; icon: string; color: string }> = {
  note_helper: { name: '笔记助手', icon: 'create-outline', color: '#4F46E5' },
  tutor: { name: '智能导师', icon: 'school-outline', color: '#059669' },
  reflection_mind: { name: '反思助手', icon: 'bulb-outline', color: '#D97706' },
  knowledge_builder: { name: '知识构建助手', icon: 'git-network-outline', color: '#6C63FF' },
};

export default function AIChatScreen() {
  const router = useSafeRouter();
  const params = useSafeSearchParams<{ agent: string; context?: string }>();
  const { agent = 'note_helper', context } = params;
  const info = AGENT_INFO[agent] || AGENT_INFO.note_helper;
  const [backgroundSecondary] = useCSSVariable(['--color-background-secondary']) as string[];
  const bgSecondary = backgroundSecondary || '#E7E7EC';

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  // 初始欢迎消息
  const welcomeMessages: Record<string, string> = {
    note_helper:
      '你好！我是笔记助手 note_helper\n\n我可以根据你的知识节点内容和笔记习惯，生成结构化的学习笔记。\n\n请告诉我你想整理哪个知识节点？',
    tutor:
      '你好！我是智能导师 tutor\n\n我可以根据你的知识库内容解答问题。如果你问的知识不在库中，我会用自有知识回答并询问你是否需要补充进知识库。\n\n请告诉我你的问题吧！',
    reflection_mind:
      '你好！我是反思助手 Reflection_mind\n\n我可以分析你的学习行为、问题解决记录和知识节点活动，生成个性化的学习反思报告。\n\n点击下方按钮开始生成反思！',
    knowledge_builder:
      '你好！我是知识构建助手 knowledge_builder\n\n我可以帮你撰写 Papercore、提取标签、分析知识关系。\n\n请提供你的原始资料内容吧！',
  };

  // 发送消息
  const handleSend = async (message: string) => {
    if (!message.trim() || isLoading) return;

    const userMsg: ChatMessage = { role: 'user', content: message };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setIsLoading(true);

    // 添加占位 AI 消息
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    let resolvedContext: any = undefined;
    if (context) {
      try {
        resolvedContext = JSON.parse(context);
      } catch {}
    }

    const url = `${process.env.EXPO_PUBLIC_BACKEND_BASE_URL}/api/v1/ai/chat`;

    const es = new RNSSE(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, message, context: resolvedContext }),
    });

    let fullContent = '';

    es.addEventListener('message', (event: any) => {
      if (event.data === '[DONE]') {
        es.close();
        setIsLoading(false);
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.content) {
          fullContent += parsed.content;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: fullContent };
            return updated;
          });
        }
      } catch {}
    });

    es.addEventListener('error', () => {
      es.close();
      setIsLoading(false);
      setMessages((prev) => {
        const updated = [...prev];
        if (updated.length > 0 && updated[updated.length - 1].content === '') {
          updated[updated.length - 1] = {
            role: 'assistant',
            content: '抱歉，AI 回复出错，请重试。',
          };
        }
        return updated;
      });
    });
  };

  // 生成反思报告：选择时间窗口 → 调 /generate-reflection 流式生成 → 完成后跳详情页
  const handleGenerateReflection = () => {
    Alert.alert('选择反思时间范围', '基于你的学习数据生成 4 维度反思报告', [
      { text: '近三天', onPress: () => startReflection('3days') },
      { text: '近一周', onPress: () => startReflection('7days') },
      { text: '近一个月', onPress: () => startReflection('30days') },
      { text: '取消', style: 'cancel' },
    ]);
  };

  const startReflection = (period: string) => {
    if (isLoading) return;
    setIsLoading(true);
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: `生成本周期的学习反思报告（${period}）` },
      { role: 'assistant', content: '' },
    ]);

    const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 'http://localhost:9091';
    const es = new RNSSE(`${BASE_URL}/api/v1/ai/generate-reflection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period }),
    });

    let fullContent = '';

    es.addEventListener('message', (event: any) => {
      if (event.data === '[DONE]') {
        es.close();
        setIsLoading(false);
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.error) {
          es.close();
          setIsLoading(false);
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: 'assistant',
              content: `生成失败：${parsed.error}`,
            };
            return updated;
          });
          return;
        }
        if (parsed.content) {
          fullContent += parsed.content;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: fullContent };
            return updated;
          });
        }
        if (parsed.done && parsed.reflection?.id) {
          if (parsed.warning) {
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: 'assistant',
                content: fullContent + `\n\n⚠️ ${parsed.warning}`,
              };
              return updated;
            });
          }
          // 报告已落库，跳转详情页查看完整 4 维度 + 图表
          setTimeout(() => {
            router.push(`/reflection-detail?id=${parsed.reflection.id}`);
          }, 600);
        }
      } catch {}
    });

    es.addEventListener('error', () => {
      es.close();
      setIsLoading(false);
      setMessages((prev) => {
        const updated = [...prev];
        if (updated.length > 0 && updated[updated.length - 1].content === '') {
          updated[updated.length - 1] = {
            role: 'assistant',
            content: '抱歉，反思生成出错，请重试。',
          };
        }
        return updated;
      });
    });
  };

  const renderMessage = ({ item, index }: { item: ChatMessage; index: number }) => {
    const isUser = item.role === 'user';
    return (
      <View className={`mb-3 ${isUser ? 'items-end' : 'items-start'}`}>
        <View
          className="max-w-[80%] rounded-2xl px-4 py-3"
          style={{
            backgroundColor: isUser ? info.color : bgSecondary,
            borderBottomRightRadius: isUser ? 4 : 16,
            borderBottomLeftRadius: isUser ? 16 : 4,
          }}
        >
          <Text className={`text-sm leading-6 ${isUser ? 'text-white' : 'text-gray-800'}`}>
            {item.content || (index === messages.length - 1 && isLoading ? '思考中...' : '')}
            {index === messages.length - 1 && isLoading && <Text className="text-gray-400">▊</Text>}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        {/* Header */}
        <View className="flex-row items-center border-b border-gray-200/60 px-4 py-3">
          <TouchableOpacity onPress={() => router.back()} className="mr-3 p-1">
            <Ionicons name="arrow-back" size={22} color="#374151" />
          </TouchableOpacity>
          <View
            className="h-9 w-9 items-center justify-center rounded-full"
            style={{ backgroundColor: info.color + '20' }}
          >
            <Ionicons name={info.icon as any} size={20} color={info.color} />
          </View>
          <Text className="ml-2 text-lg font-semibold text-gray-800">{info.name}</Text>
        </View>

        {/* Messages */}
        {messages.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8">
            <View
              className="mb-5 h-20 w-20 items-center justify-center rounded-full"
              style={{ backgroundColor: info.color + '15' }}
            >
              <Ionicons name={info.icon as any} size={40} color={info.color} />
            </View>
            <Text className="mb-2 text-xl font-bold text-gray-800">{info.name}</Text>
            <Text className="text-center text-sm leading-6 text-gray-500">
              {welcomeMessages[agent]}
            </Text>
            {agent === 'reflection_mind' && (
              <TouchableOpacity
                onPress={handleGenerateReflection}
                className="mt-6 rounded-xl px-6 py-3"
                style={{ backgroundColor: info.color }}
              >
                <Text className="font-semibold text-white"> 生成学习反思报告</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(_, i) => i.toString()}
            className="flex-1 px-4 pt-4"
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          />
        )}

        {/* Input */}
        {agent !== 'reflection_mind' && (
          <View
            className="border-t border-gray-200/60 px-3 py-2"
            style={{ backgroundColor: '#F8F9FA' }}
          >
            <View
              className="flex-row items-center rounded-2xl bg-white px-4 py-1"
              style={{ borderWidth: 1, borderColor: '#E5E7EB' }}
            >
              <TextInput
                className="max-h-24 flex-1 py-2 text-sm text-gray-800"
                placeholder="输入你的问题..."
                placeholderTextColor="#9CA3AF"
                value={input}
                onChangeText={setInput}
                multiline
                selectionColorClassName="accent-indigo-500"
              />
              <TouchableOpacity
                onPress={() => handleSend(input)}
                disabled={!input.trim() || isLoading}
                className="ml-2 h-9 w-9 items-center justify-center rounded-full"
                style={{ backgroundColor: input.trim() && !isLoading ? info.color : '#D1D5DB' }}
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Ionicons name="send" size={16} color="#fff" />
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}
