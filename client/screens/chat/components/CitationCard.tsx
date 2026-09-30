import { Badge, BadgeText, Card, HStack, Text, VStack } from '@/components/ui';
import type { Citation } from '../types';

const META: Record<string, string> = {
  image: '图片',
  knowledge_node: '知识节点',
  node: '知识节点',
  study_note: '学习纪要',
  material: '资料',
  file_content: '原文',
  file: '原文',
};

function CitationCard({ citation }: { citation: Citation }) {
  const type = citation.type || 'file';
  const label = META[type] || '来源';
  const title =
    citation.title || citation.label || citation.fileName || citation.file_name || '引用来源';
  const page = citation.pageNumber || citation.page;

  return (
    <Card size="sm">
      <HStack className="items-start justify-between gap-3">
        <VStack className="min-w-0 flex-1">
          <Text size="sm" bold isTruncated>
            {title}
          </Text>
          {page ? (
            <Text size="sm" className="text-muted-foreground">
              第 {page} 页
            </Text>
          ) : null}
          {(citation.snippet || citation.papercore) && (
            <Text size="sm" className="text-muted-foreground">
              {citation.snippet || citation.papercore}
            </Text>
          )}
        </VStack>
        <Badge variant="secondary">
          <BadgeText>{label}</BadgeText>
        </Badge>
      </HStack>
      {!!citation.tags?.length && (
        <HStack className="flex-wrap gap-2">
          {citation.tags.slice(0, 5).map((tag) => (
            <Badge key={tag} variant="outline">
              <BadgeText>{tag}</BadgeText>
            </Badge>
          ))}
        </HStack>
      )}
    </Card>
  );
}

export default CitationCard;
