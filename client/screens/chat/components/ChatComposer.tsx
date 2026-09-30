import {
  Button,
  ButtonText,
  Card,
  HStack,
  Text,
  Textarea,
  TextareaInput,
  VStack,
} from '@/components/ui';
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
}: ChatComposerProps) {
  const disabled = !value.trim() || loading;
  const selectedNode = knowledgeNodes.find((node) => node.id === selectedNodeId);

  return (
    <Card className="mx-3 mb-3">
      <HStack className="flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onPress={onOpenUpload} aria-label="上传图片材料">
          <ButtonText>{uploadFile ? uploadFile.name : '添加图片'}</ButtonText>
        </Button>
        {uploadFile && (
          <Button size="sm" variant="ghost" onPress={onRemoveUpload} aria-label="移除图片材料">
            <ButtonText>移除</ButtonText>
          </Button>
        )}
        <Button
          size="sm"
          variant={selectedNodeId ? 'secondary' : 'outline'}
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
          aria-label="切换知识节点"
        >
          <ButtonText>{selectedNode?.short_name || '绑定知识节点'}</ButtonText>
        </Button>
      </HStack>

      <Textarea size="md">
        <TextareaInput
          value={value}
          onChangeText={onChange}
          placeholder="问一个具体问题，例如：这页公式为什么成立？"
          accessibilityLabel="聊天输入框"
        />
      </Textarea>

      <HStack className="items-center justify-between gap-3">
        <Text size="sm" className="text-muted-foreground">
          {selectedNode ? `长期上下文：${selectedNode.short_name}` : '未绑定知识节点'}
        </Text>
        <Button onPress={onSubmit} disabled={disabled} aria-label="发送消息">
          <ButtonText>{loading ? '发送中' : '发送'}</ButtonText>
        </Button>
      </HStack>
    </Card>
  );
}

export default ChatComposer;
