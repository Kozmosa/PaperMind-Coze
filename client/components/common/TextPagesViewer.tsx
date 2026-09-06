import { ScrollView, Text, View, StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export type TextPage = { page_number: number; text: string };

type TextPagesViewerProps = {
  pages: TextPage[];
  style?: StyleProp<ViewStyle>;
};

// PPTX/DOCX/MD 等提取文本的分页预览（PDF 走文件 viewer，不走这里）
export default function TextPagesViewer({ pages, style }: TextPagesViewerProps) {
  return (
    <ScrollView
      style={[styles.scroll, style]}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={true}
    >
      {pages.map((page, i) => (
        <View key={i} style={styles.page}>
          {i > 0 && <Text style={styles.pageDivider}>— 第 {page.page_number || i + 1} 页 —</Text>}
          <Text style={styles.pageText}>{page.text}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  page: {
    marginBottom: 16,
  },
  pageDivider: {
    fontSize: 11,
    color: '#C0C0C0',
    textAlign: 'center',
    marginBottom: 12,
  },
  pageText: {
    fontSize: 14,
    color: '#1A1A1A',
    lineHeight: 22,
  },
});
