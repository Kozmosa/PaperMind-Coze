import { Button, ButtonText, Card, Divider, Pressable, Text, VStack } from '@/components/ui';
import type { ChatSession } from '../types';

interface HistoryPanelProps {
  sessions: ChatSession[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

function HistoryPanel({ sessions, onSelect, onClose }: HistoryPanelProps) {
  return (
    <Card size="sm">
      <VStack>
        <Text bold>历史对话</Text>
        <Text size="sm" className="text-muted-foreground">
          继续上一次的学习线索
        </Text>
      </VStack>

      <Divider />

      <VStack>
        {sessions.map((session) => (
          <Pressable
            key={session.id}
            onPress={() => onSelect(session.id)}
            className="bg-background rounded-md p-3"
            accessibilityRole="button"
          >
            <Text>{session.title || '未命名对话'}</Text>
            <Text size="sm" className="text-muted-foreground">
              {new Date(session.lastTime).toLocaleDateString('zh-CN')}
            </Text>
          </Pressable>
        ))}
        {sessions.length === 0 && <Text className="text-muted-foreground p-3">暂无历史对话</Text>}
      </VStack>

      <Divider />

      <Button size="sm" variant="ghost" onPress={onClose}>
        <ButtonText>收起面板</ButtonText>
      </Button>
    </Card>
  );
}

export default HistoryPanel;
