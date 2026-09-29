import { ScrollView, View } from 'react-native';
import { Chip, IconButton, Surface, Text, useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';

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
  const theme = useTheme<MD3Theme>();

  return (
    <Surface
      elevation={0}
      style={{
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.outlineVariant,
        backgroundColor: theme.colors.surface,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          paddingHorizontal: compact ? 8 : 16,
          paddingVertical: 10,
        }}
      >
        <IconButton
          icon="menu"
          onPress={onToggleHistory}
          accessibilityLabel="打开历史对话"
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="titleLarge" numberOfLines={1} style={{ fontWeight: '700' }}>
            PaperMind 工作台
          </Text>
          {!compact && (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              从材料到提问、理解、沉淀的单一入口
            </Text>
          )}
        </View>
        <IconButton
          icon={isDark ? 'weather-sunny' : 'weather-night'}
          onPress={onToggleTheme}
          accessibilityLabel="切换亮暗色主题"
        />
        {!compact && (
          <>
            <IconButton
              icon="graph-outline"
              onPress={onOpenKnowledgeBuilder}
              accessibilityLabel="构建知识节点"
            />
            <IconButton
              icon="chart-line"
              onPress={onOpenProblemLogs}
              accessibilityLabel="查看解答日志"
            />
          </>
        )}
        <IconButton
          icon="plus"
          onPress={onNewSession}
          accessibilityLabel="开始新对话"
        />
      </View>

      <View style={{ paddingHorizontal: compact ? 12 : 18, paddingBottom: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Chip
            selected
            icon="school"
            compact
            style={{ marginRight: 8, backgroundColor: theme.colors.primaryContainer }}
            textStyle={{ color: theme.colors.onPrimaryContainer }}
          >
            智能导师
          </Chip>
          <Chip icon="book-multiple-outline" compact style={{ marginRight: 8 }}>
            知识库检索
          </Chip>
          <Chip icon="file-document-outline" compact style={{ marginRight: 8 }}>
            材料上下文
          </Chip>
          <Chip icon="check-circle-outline" compact>
            问题日志
          </Chip>
        </ScrollView>
      </View>
    </Surface>
  );
}

export default ChatHeader;
