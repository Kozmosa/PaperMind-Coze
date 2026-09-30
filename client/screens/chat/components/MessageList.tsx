import { Image } from 'react-native';
import { Button, ButtonText, Card, HStack, Spinner, Text, VStack } from '@/components/ui';
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

const STARTERS = ['解释一个刚上传的概念', '帮我推导一道错题', '总结今天的学习材料'];

function MessageList({ messages, loading, colorScheme, onPrompt, onUnderstood }: MessageListProps) {
  const showUnderstood =
    messages.length >= 2 && messages[messages.length - 1].role === 'assistant' && !loading;

  return (
    <VStack>
      {messages.length === 0 && !loading && (
        <Card>
          <VStack>
            <Text size="lg" bold>
              今天要从哪里开始？
            </Text>
            <Text size="sm" className="text-muted-foreground">
              上传材料、绑定知识节点，或者直接提出问题。
            </Text>
          </VStack>
          <VStack>
            {STARTERS.map((starter) => (
              <Button key={starter} variant="secondary" onPress={() => onPrompt(starter)}>
                <ButtonText>{starter}</ButtonText>
              </Button>
            ))}
          </VStack>
        </Card>
      )}

      {messages.map((message) => {
        const isUser = message.role === 'user';
        return (
          <Card key={message.id}>
            <HStack className="items-center justify-between gap-3">
              <Text bold>{isUser ? '你' : 'PaperMind'}</Text>
              <Text size="sm" className="text-muted-foreground" isTruncated>
                {new Date(message.timestamp).toLocaleString('zh-CN')}
              </Text>
            </HStack>
            {message.imageUri && (
              <Image
                source={{ uri: message.imageUri }}
                resizeMode="cover"
                className="aspect-[4/3] w-full rounded-lg"
                accessibilityLabel="用户上传图片"
              />
            )}
            <VStack>
              {isUser ? (
                <Text>{message.content}</Text>
              ) : message.content ? (
                <MarkdownRenderer content={message.content} colorScheme={colorScheme} />
              ) : (
                <Text>正在整理回答...</Text>
              )}
            </VStack>
            {!isUser && !!message.citations?.length && (
              <VStack>
                <Text size="sm" bold>
                  引用来源
                </Text>
                {message.citations.map((citation, index) => (
                  <CitationCard key={`${message.id}-citation-${index}`} citation={citation} />
                ))}
              </VStack>
            )}
          </Card>
        );
      })}

      {loading && (
        <HStack className="items-center gap-2">
          <Spinner size="small" />
          <Text className="text-muted-foreground">正在连接知识上下文...</Text>
        </HStack>
      )}

      {showUnderstood && (
        <Button variant="secondary" onPress={onUnderstood}>
          <ButtonText>我明白了，记录到问题日志</ButtonText>
        </Button>
      )}
    </VStack>
  );
}

export default MessageList;
