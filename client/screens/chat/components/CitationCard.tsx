import { View } from 'react-native';
import { Chip, Surface, Text, useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';
import type { Citation } from '../types';

const META: Record<string, { label: string; icon: string; tone: 'primary' | 'tertiary' | 'secondary' }> = {
  image: { label: '图片', icon: 'image-outline', tone: 'tertiary' },
  knowledge_node: { label: '知识节点', icon: 'book-outline', tone: 'primary' },
  node: { label: '知识节点', icon: 'book-outline', tone: 'primary' },
  study_note: { label: '学习纪要', icon: 'note-edit-outline', tone: 'tertiary' },
  material: { label: '资料', icon: 'file-document-outline', tone: 'secondary' },
  file_content: { label: '原文', icon: 'text-box-outline', tone: 'secondary' },
  file: { label: '原文', icon: 'text-box-outline', tone: 'secondary' },
};

function CitationCard({ citation }: { citation: Citation }) {
  const theme = useTheme<MD3Theme>();
  const type = citation.type || 'file';
  const meta = META[type] || { label: '来源', icon: 'link-variant', tone: 'secondary' as const };
  const title =
    citation.title ||
    citation.label ||
    citation.fileName ||
    citation.file_name ||
    '引用来源';
  const page = citation.pageNumber || citation.page;
  const toneColor =
    meta.tone === 'primary'
      ? theme.colors.primary
      : meta.tone === 'tertiary'
        ? theme.colors.tertiary
        : theme.colors.secondary;

  return (
    <Surface
      elevation={0}
      style={{
        borderRadius: theme.roundness,
        borderWidth: 1,
        borderColor: theme.colors.outlineVariant,
        backgroundColor: theme.colors.surface,
        padding: 12,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Chip
          compact
          icon={meta.icon}
          style={{ backgroundColor: `${toneColor}22` }}
          textStyle={{ color: toneColor }}
        >
          {meta.label}
        </Chip>
        <Text variant="labelMedium" numberOfLines={1} style={{ flex: 1, color: toneColor }}>
          {title}
        </Text>
        {page ? <Text variant="labelSmall">第 {page} 页</Text> : null}
      </View>
      {(citation.snippet || citation.papercore) && (
        <Text
          variant="bodySmall"
          numberOfLines={3}
          style={{ marginTop: 8, lineHeight: 19, color: theme.colors.onSurfaceVariant }}
        >
          {citation.snippet || citation.papercore}
        </Text>
      )}
      {!!citation.tags?.length && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {citation.tags.slice(0, 5).map((tag) => (
            <Chip key={tag} compact icon="tag-outline">
              {tag}
            </Chip>
          ))}
        </View>
      )}
    </Surface>
  );
}

export default CitationCard;
