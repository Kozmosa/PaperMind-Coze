import { ScrollView, View } from 'react-native';
import { Button, Divider, List, Surface, Text, useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import type { ChatSession } from '../types';

interface HistoryPanelProps {
  sessions: ChatSession[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

function HistoryPanel({ sessions, onSelect, onClose }: HistoryPanelProps) {
  const theme = useTheme<MD3Theme>();

  return (
    <Surface
      elevation={0}
      style={{
        width: 282,
        borderRightWidth: 1,
        borderRightColor: theme.colors.outlineVariant,
        backgroundColor: theme.colors.surface,
      }}
    >
      <View style={{ paddingHorizontal: 18, paddingVertical: 18 }}>
        <Text variant="titleMedium" style={{ fontWeight: '700' }}>
          历史对话
        </Text>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
          继续上一次的学习线索
        </Text>
      </View>
      <Divider />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 16 }}>
        {sessions.map((session, index) => (
          <View key={session.id}>
            <List.Item
              title={session.title || '未命名对话'}
              titleNumberOfLines={2}
              description={new Date(session.lastTime).toLocaleDateString('zh-CN')}
              left={(props) => <List.Icon {...props} icon="comment-text-outline" />}
              onPress={() => onSelect(session.id)}
            />
            {index < sessions.length - 1 && <Divider />}
          </View>
        ))}
        {sessions.length === 0 && (
          <View style={{ padding: 24, alignItems: 'center' }}>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              暂无历史对话
            </Text>
          </View>
        )}
      </ScrollView>
      <Divider />
      <View style={{ padding: 12 }}>
        <Button mode="text" icon="close" onPress={onClose}>
          收起面板
        </Button>
      </View>
    </Surface>
  );
}

export default HistoryPanel;
