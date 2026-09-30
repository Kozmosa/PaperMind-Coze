import { Button, ButtonText, HStack, Heading, Text, VStack } from '@/components/ui';

interface ChatHeaderProps {
  onToggleHistory: () => void;
  onNewSession: () => void;
  onOpenKnowledgeBuilder: () => void;
  onOpenProblemLogs: () => void;
  onToggleTheme: () => void;
  isDark: boolean;
  compact: boolean;
}

function ChatHeader({
  onToggleHistory,
  onNewSession,
  onOpenKnowledgeBuilder,
  onOpenProblemLogs,
  onToggleTheme,
  isDark,
  compact,
}: ChatHeaderProps) {
  return (
    <HStack className="border-border bg-background items-center justify-between gap-3 border-b px-4 py-3">
      <VStack className="min-w-0 flex-1">
        <Heading size="md" isTruncated>
          PaperMind 工作台
        </Heading>
        {!compact && (
          <Text size="sm" className="text-muted-foreground">
            从材料到提问、理解、沉淀的单一入口
          </Text>
        )}
      </VStack>

      <HStack className="flex-wrap justify-end gap-1">
        <Button size="sm" variant="ghost" onPress={onToggleHistory} aria-label="打开历史对话">
          <ButtonText>历史</ButtonText>
        </Button>
        <Button size="sm" variant="ghost" onPress={onToggleTheme} aria-label="切换主题">
          <ButtonText>{isDark ? '亮色' : '暗色'}</ButtonText>
        </Button>
        {!compact && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onPress={onOpenKnowledgeBuilder}
              aria-label="构建知识节点"
            >
              <ButtonText>知识</ButtonText>
            </Button>
            <Button size="sm" variant="ghost" onPress={onOpenProblemLogs} aria-label="查看解答日志">
              <ButtonText>日志</ButtonText>
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" onPress={onNewSession} aria-label="开始新对话">
          <ButtonText>新对话</ButtonText>
        </Button>
      </HStack>
    </HStack>
  );
}

export default ChatHeader;
