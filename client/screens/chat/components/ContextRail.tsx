import { View } from 'react-native';
import { Button, Card, Chip, List, Text, useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import type { KnowledgeNode } from '../types';

interface ContextRailProps {
  knowledgeNodes: KnowledgeNode[];
  selectedNodeId: number | null;
  onSelectNode: (id: number | null) => void;
  onPrompt: (prompt: string) => void;
  onOpenKnowledgeBase: () => void;
}

const PROMPTS = [
  '帮我解释这篇材料的核心概念',
  '把我的疑问拆成三步推导',
  '用已有知识库回答并给出来源',
];

function ContextRail({
  knowledgeNodes,
  selectedNodeId,
  onSelectNode,
  onPrompt,
  onOpenKnowledgeBase,
}: ContextRailProps) {
  const theme = useTheme<MD3Theme>();
  const selectedNode = knowledgeNodes.find((node) => node.id === selectedNodeId);

  return (
    <View
      style={{
        width: 312,
        padding: 16,
        borderLeftWidth: 1,
        borderLeftColor: theme.colors.outlineVariant,
        backgroundColor: theme.colors.surfaceVariant,
        gap: 14,
      }}
    >
      <Card elevation={0} style={{ backgroundColor: theme.colors.surface }}>
        <Card.Title
          title="当前上下文"
          titleVariant="titleMedium"
          subtitle={selectedNode ? selectedNode.short_name : '未绑定知识节点'}
          subtitleNumberOfLines={2}
          left={(props) => (
            <List.Icon {...props} icon="book-outline" />
          )}
        />
        <Card.Content>
          {selectedNode?.papercore ? (
            <Text
              variant="bodySmall"
              numberOfLines={4}
              style={{ color: theme.colors.onSurfaceVariant, lineHeight: 19 }}
            >
              {selectedNode.papercore}
            </Text>
          ) : (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              上传材料或选择节点后，回答会优先引用你的个人知识库。
            </Text>
          )}
        </Card.Content>
        <Card.Actions>
          <Button compact mode="text" onPress={onOpenKnowledgeBase}>
            打开知识库
          </Button>
          {selectedNodeId && (
            <Button compact mode="text" onPress={() => onSelectNode(null)}>
              取消绑定
            </Button>
          )}
        </Card.Actions>
      </Card>

      <Card elevation={0} style={{ backgroundColor: theme.colors.surface }}>
        <Card.Title title="学习闭环" titleVariant="titleMedium" />
        <Card.Content style={{ gap: 8 }}>
          {PROMPTS.map((prompt) => (
            <Chip
              key={prompt}
              icon="lightning-bolt-circle"
              onPress={() => onPrompt(prompt)}
              textStyle={{ color: theme.colors.onSurface }}
            >
              {prompt}
            </Chip>
          ))}
        </Card.Content>
      </Card>
    </View>
  );
}

export default ContextRail;
