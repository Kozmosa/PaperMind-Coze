import { View } from 'react-native';
import { Button, Card, Modal, Portal, Text, useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import type { KnowledgeNode } from '../types';

interface UploadDialogProps {
  visible: boolean;
  onClose: () => void;
  onSelectImage: () => void;
  knowledgeNodes: KnowledgeNode[];
  selectedNodeId: number | null;
  onSelectNode: (nodeId: number | null) => void;
  compact: boolean;
}

function UploadDialog({
  visible,
  onClose,
  onSelectImage,
  knowledgeNodes,
  selectedNodeId,
  onSelectNode,
  compact,
}: UploadDialogProps) {
  const theme = useTheme<MD3Theme>();

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onClose}
        contentContainerStyle={{
          maxWidth: compact ? undefined : 520,
          width: compact ? '92%' : '100%',
          alignSelf: 'center',
        }}
      >
        <Card elevation={2} style={{ backgroundColor: theme.colors.surface }}>
          <Card.Title title="添加学习上下文" titleVariant="titleLarge" />
          <Card.Content style={{ gap: 14 }}>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              图片会作为当前提问的短期上下文；知识节点会作为长期上下文参与检索。
            </Text>
            <View style={{ gap: 8 }}>
              {knowledgeNodes.slice(0, 5).map((node) => {
                const selected = selectedNodeId === node.id;
                return (
                  <Button
                    key={node.id}
                    mode={selected ? 'contained' : 'outlined'}
                    icon={selected ? 'check-circle-outline' : 'book-outline'}
                    onPress={() => onSelectNode(selected ? null : node.id)}
                    contentStyle={{ justifyContent: 'flex-start' }}
                  >
                    {node.short_name}
                  </Button>
                );
              })}
            </View>
          </Card.Content>
          <Card.Actions>
            <Button onPress={onClose}>取消</Button>
            <Button
              mode="contained"
              icon="image-plus"
              onPress={onSelectImage}
            >
              选择图片
            </Button>
          </Card.Actions>
        </Card>
      </Modal>
    </Portal>
  );
}

export default UploadDialog;
