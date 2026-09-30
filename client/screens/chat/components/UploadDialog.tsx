import {
  Button,
  ButtonText,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Text,
  VStack,
} from '@/components/ui';
import type { KnowledgeNode } from '../types';

interface UploadDialogProps {
  visible: boolean;
  onClose: () => void;
  onSelectImage: () => void;
  knowledgeNodes: KnowledgeNode[];
  selectedNodeId: number | null;
  onSelectNode: (nodeId: number | null) => void;
}

function UploadDialog({
  visible,
  onClose,
  onSelectImage,
  knowledgeNodes,
  selectedNodeId,
  onSelectNode,
}: UploadDialogProps) {
  return (
    <Modal isOpen={visible} onClose={onClose} size="lg">
      <ModalBackdrop onPress={onClose} />
      <ModalContent>
        <ModalHeader>
          <Text size="lg" bold>
            添加学习上下文
          </Text>
        </ModalHeader>
        <ModalBody>
          <VStack>
            <Text size="sm" className="text-muted-foreground">
              图片会作为当前提问的短期上下文；知识节点会作为长期上下文参与检索。
            </Text>
            {knowledgeNodes.slice(0, 5).map((node) => {
              const selected = selectedNodeId === node.id;
              return (
                <Button
                  key={node.id}
                  variant={selected ? 'default' : 'outline'}
                  onPress={() => onSelectNode(selected ? null : node.id)}
                >
                  <ButtonText>{node.short_name}</ButtonText>
                </Button>
              );
            })}
          </VStack>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onPress={onClose}>
            <ButtonText>取消</ButtonText>
          </Button>
          <Button onPress={onSelectImage}>
            <ButtonText>选择图片</ButtonText>
          </Button>
        </ModalFooter>
        <ModalCloseButton onPress={onClose} aria-label="关闭上传对话框" />
      </ModalContent>
    </Modal>
  );
}

export default UploadDialog;
