import { View } from 'react-native';
import {
  Chip,
  IconButton,
  Surface,
  TextInput,
  useTheme,
} from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import { noWebResize } from '@/utils';
import type { KnowledgeNode, UploadFile } from '../types';

interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  uploadFile: UploadFile | null;
  onRemoveUpload: () => void;
  onOpenUpload: () => void;
  knowledgeNodes: KnowledgeNode[];
  selectedNodeId: number | null;
  onSelectNode: (nodeId: number | null) => void;
  compact: boolean;
}

function ChatComposer({
  value,
  onChange,
  onSubmit,
  loading,
  uploadFile,
  onRemoveUpload,
  onOpenUpload,
  knowledgeNodes,
  selectedNodeId,
  onSelectNode,
  compact,
}: ChatComposerProps) {
  const theme = useTheme<MD3Theme>();
  const disabled = !value.trim() || loading;

  return (
    <Surface
      elevation={0}
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.outlineVariant,
        backgroundColor: theme.colors.surface,
        paddingHorizontal: compact ? 10 : 20,
        paddingTop: 10,
        paddingBottom: 12,
      }}
    >
      <View style={{ maxWidth: 880, width: '100%', alignSelf: 'center', gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {uploadFile && (
            <Chip
              icon="attachment"
              closeIcon="close"
              onClose={onRemoveUpload}
              style={{ backgroundColor: theme.colors.secondaryContainer }}
              textStyle={{ color: theme.colors.onSecondaryContainer }}
            >
              {uploadFile.name}
            </Chip>
          )}
          <Chip
            icon={selectedNodeId ? 'book-check-outline' : 'book-plus-outline'}
            onPress={() => {
              if (!knowledgeNodes.length) {
                onSelectNode(null);
                return;
              }
              const currentIndex = knowledgeNodes.findIndex((node) => node.id === selectedNodeId);
              const next =
                currentIndex === -1
                  ? knowledgeNodes[0].id
                  : knowledgeNodes[(currentIndex + 1) % knowledgeNodes.length].id;
              onSelectNode(next);
            }}
          >
            {selectedNodeId
              ? knowledgeNodes.find((node) => node.id === selectedNodeId)?.short_name || '知识节点'
              : '绑定知识节点'}
          </Chip>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
          <IconButton
            icon="paperclip-plus"
            mode="contained-tonal"
            onPress={onOpenUpload}
            accessibilityLabel="上传图片材料"
          />
          <TextInput
            value={value}
            onChangeText={onChange}
            placeholder="问一个具体问题，例如：这页公式为什么成立？"
            multiline
            mode="outlined"
            dense
            style={{ flex: 1, minHeight: 52, ...noWebResize }}
            contentStyle={{
              paddingHorizontal: 8,
              paddingVertical: 8,
              fontSize: 15,
            }}
            right={
              <TextInput.Icon
                icon={disabled ? 'send-circle-outline' : 'send'}
                onPress={onSubmit}
                disabled={disabled}
                forceTextInputFocus={false}
              />
            }
          />
        </View>
      </View>
    </Surface>
  );
}

export default ChatComposer;
