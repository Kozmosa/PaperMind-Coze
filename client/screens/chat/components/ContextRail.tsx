import { Button, ButtonText, Card, Divider, HStack, Text, VStack } from '@/components/ui';
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
  const selectedNode = knowledgeNodes.find((node) => node.id === selectedNodeId);

  return (
    <Card>
      <VStack>
        <Text size="sm" className="text-muted-foreground">
          当前上下文
        </Text>
        <Text bold isTruncated>
          {selectedNode ? selectedNode.short_name : '未绑定知识节点'}
        </Text>
        <Text size="sm" className="text-muted-foreground">
          {selectedNode?.papercore || '上传材料或选择节点后，回答会优先引用你的个人知识库。'}
        </Text>
      </VStack>

      <HStack className="flex-wrap gap-2">
        <Button size="sm" variant="ghost" onPress={onOpenKnowledgeBase}>
          <ButtonText>打开知识库</ButtonText>
        </Button>
        {selectedNodeId && (
          <Button size="sm" variant="ghost" onPress={() => onSelectNode(null)}>
            <ButtonText>取消绑定</ButtonText>
          </Button>
        )}
      </HStack>

      <Divider />

      <VStack>
        <Text bold>学习闭环</Text>
        {PROMPTS.map((prompt) => (
          <Button key={prompt} size="sm" variant="outline" onPress={() => onPrompt(prompt)}>
            <ButtonText>{prompt}</ButtonText>
          </Button>
        ))}
      </VStack>
    </Card>
  );
}

export default ContextRail;
