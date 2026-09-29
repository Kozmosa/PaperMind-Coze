import { useEffect, useRef } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { ActivityIndicator, Button, Card, Surface, Text, useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import MarkdownRenderer from '@/components/markdown/MarkdownRenderer';
import CitationCard from './CitationCard';
import type { ChatMessage } from '../types';

interface MessageListProps {
  messages: ChatMessage[];
  loading: boolean;
  colorScheme: 'light' | 'dark';
  onPrompt: (prompt: string) => void;
  onUnderstood: () => void;
}

const STARTERS = [
  '解释一个刚上传的概念',
  '帮我推导一道错题',
  '总结今天的学习材料',
];

function MessageList({
  messages,
  loading,
  colorScheme,
  onPrompt,
  onUnderstood,
}: MessageListProps) {
  const theme = useTheme<MD3Theme>();
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages, loading]);

  const showUnderstood =
    messages.length >= 2 && messages[messages.length - 1].role === 'assistant' && !loading;

  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{
        maxWidth: 880,
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: 16,
        paddingVertical: 18,
      }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {messages.length === 0 && !loading && (
        <Card
          elevation={0}
          style={{
            marginTop: 18,
            backgroundColor: theme.colors.primaryContainer,
            borderRadius: 28,
          }}
        >
          <Card.Title
            title="今天要从哪里开始？"
            titleVariant="headlineSmall"
            titleStyle={{ fontWeight: '700' }}
            subtitle="上传材料、绑定知识节点，或者直接提出问题。"
            subtitleNumberOfLines={3}
          />
          <Card.Content style={{ gap: 8 }}>
            {STARTERS.map((starter) => (
              <Button
                key={starter}
                mode="contained-tonal"
                icon="arrow-right-top"
                onPress={() => onPrompt(starter)}
                contentStyle={{ justifyContent: 'flex-start' }}
              >
                {starter}
              </Button>
            ))}
          </Card.Content>
        </Card>
      )}

      {messages.map((message) => {
        const isUser = message.role === 'user';
        return (
          <View
            key={message.id}
            style={{
              marginBottom: 14,
              alignItems: isUser ? 'flex-end' : 'flex-start',
            }}
          >
            <Surface
              elevation={0}
              style={{
                maxWidth: isUser ? '86%' : '100%',
                borderRadius: 24,
                borderBottomRightRadius: isUser ? 8 : 24,
                borderBottomLeftRadius: isUser ? 24 : 8,
                paddingHorizontal: 16,
                paddingVertical: 12,
                backgroundColor: isUser
                  ? theme.colors.primary
                  : theme.colors.surfaceVariant,
              }}
            >
              {message.imageUri && (
                <Image
                  source={{ uri: message.imageUri }}
                  style={{
                    width: 210,
                    height: 145,
                    borderRadius: 16,
                    marginBottom: 8,
                  }}
                  resizeMode="cover"
                />
              )}
              {isUser ? (
                <Text
                  variant="bodyMedium"
                  style={{
                    color: theme.colors.onPrimary,
                    lineHeight: 23,
                  }}
                >
                  {message.content}
                </Text>
              ) : message.content ? (
                <MarkdownRenderer content={message.content} colorScheme={colorScheme} />
              ) : (
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  正在整理回答...
                </Text>
              )}
            </Surface>

            {!isUser && !!message.citations?.length && (
              <View style={{ marginTop: 10, width: '100%', maxWidth: 760, gap: 8 }}>
                <Text variant="labelLarge" style={{ color: theme.colors.primary }}>
                  引用来源
                </Text>
                {message.citations.map((citation, index) => (
                  <CitationCard key={`${message.id}-citation-${index}`} citation={citation} />
                ))}
              </View>
            )}
          </View>
        );
      })}

      {loading && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <ActivityIndicator size="small" />
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            正在连接知识上下文...
          </Text>
        </View>
      )}

      {showUnderstood && (
        <Button
          mode="contained-tonal"
          icon="check-circle-outline"
          onPress={onUnderstood}
          style={{ alignSelf: 'center', marginTop: 2 }}
        >
          我明白了，记录到问题日志
        </Button>
      )}
    </ScrollView>
  );
}

export default MessageList;
