import { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
  Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { api } from '@/utils/api';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const CARD_WIDTH = Math.min(SCREEN_WIDTH * 0.92, 400);

export type Citation = {
  index: number;
  sourceId: string;
  sourceType: string;
  fileName: string;
  highlightText?: string;
  pageNumber?: number | null;
};

type ReferenceCardProps = {
  citation: Citation | null;
  visible: boolean;
  onClose: () => void;
};

function PDFViewer({ url }: { url: string }) {
  const encodedUrl = encodeURIComponent(url);
  const googleViewerUrl = `https://docs.google.com/viewer?url=${encodedUrl}&embedded=true`;

  if (Platform.OS === 'web') {
    return (
      <iframe
        src={url}
        style={{ width: '100%', height: 280, border: 'none', borderRadius: 8 }}
        title="PDF"
      />
    );
  }

  try {
    const WebView = require('react-native-webview').WebView;
    return (
      <WebView
        source={{ uri: url }}
        style={{ flex: 1, minHeight: 280, backgroundColor: 'transparent' }}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        allowUniversalAccessFromFileURLs={true}
        mixedContentMode="always"
      />
    );
  } catch {
    return (
      <Text style={styles.contentText}>PDF 预览需要 WebView 支持</Text>
    );
  }
}

export default function ReferenceCard({ citation, visible, onClose }: ReferenceCardProps) {
  const [content, setContent] = useState('');
  const [viewUrl, setViewUrl] = useState('');
  const [fileType, setFileType] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (visible && citation) {
      loadContent();
    } else {
      setContent('');
      setViewUrl('');
      setFileType('');
      setError('');
    }
  }, [visible, citation?.sourceId, citation?.index]);

  const loadContent = async () => {
    if (!citation) return;
    setLoading(true);
    setError('');
    setViewUrl('');
    try {
      const res: any = await api.getSourceFileContent(citation.sourceId, citation.sourceType as any);
      const data = res.data;
      if (data) {
        if (citation.sourceType === 'study_note') {
          let text = data.content || '';
          if (data.blocks && Array.isArray(data.blocks)) {
            text = data.blocks
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.content || '')
              .join('\n\n');
          }
          setContent(text.substring(0, 3000));
        } else if (citation.sourceType === 'knowledge_node') {
          // Fetch knowledge node details
          try {
            const nodeRes: any = await api.getKnowledgeNodes();
            const nodes: any[] = nodeRes?.data?.data || nodeRes?.data || [];
            const node = Array.isArray(nodes)
              ? nodes.find((n: any) => String(n.id) === String(citation.sourceId))
              : null;
            if (node) {
              const parts: string[] = [];
              if (node.papercore) parts.push(`📝 Papercore:\n${node.papercore}`);
              if (node.tags?.length) parts.push(`🏷️ 标签: ${node.tags.map((t: string) => `#${t}`).join(' ')}`);
              if (node.relations && Object.keys(node.relations).length > 0) {
                parts.push(`🔗 关联: ${JSON.stringify(node.relations)}`);
              }
              setContent(parts.join('\n\n') || '(无内容)');
            } else {
              setContent('(知识节点已加载)');
            }
          } catch {
            setContent('(知识节点)');
          }
        } else {
          // material: show original file, not OCR text
          if (data.viewUrl) {
            setViewUrl(data.viewUrl);
            setFileType(data.fileType || '');
          } else if (data.pages && Array.isArray(data.pages)) {
            setContent(data.pages.map((p: any) => p.text || '').join('\n\n').substring(0, 2000));
          } else {
            setContent('(文件不可用)');
          }
        }
      } else {
        setError('无法加载来源内容');
      }
    } catch (e) {
      setError('加载失败');
    } finally {
      setLoading(false);
    }
  };

  if (!visible || !citation) return null;

  // Pick icon based on sourceType
  const sourceIcon =
    citation.sourceType === 'knowledge_node' ? 'book-open' :
    citation.sourceType === 'study_note' ? 'edit-3' :
    citation.sourceType === 'material' ? 'file-text' :
    citation.sourceType === 'file_content' ? 'file-text' :
    'file-text';

  const sourceColor =
    citation.sourceType === 'knowledge_node' ? '#6C63FF' :
    citation.sourceType === 'study_note' ? '#00B894' :
    citation.sourceType === 'material' ? '#FF9F43' :
    '#636E72';

  const sourceLabel =
    citation.sourceType === 'knowledge_node' ? '知识节点' :
    citation.sourceType === 'study_note' ? '学习纪要' :
    citation.sourceType === 'material' ? '学习资料' :
    '文件';

  const isMaterialPDF = (citation.sourceType === 'material' || citation.sourceType === 'file_content') && viewUrl;

  return (
    <View style={styles.overlay}>
      <TouchableOpacity style={styles.backdrop} onPress={onClose} activeOpacity={1} />
      <View style={[styles.card, isMaterialPDF && styles.cardWide]}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Feather name={sourceIcon} size={16} color={sourceColor} />
            <Text style={styles.headerTitle} numberOfLines={1}>
              来自：{citation.fileName}
            </Text>
            <View style={{ backgroundColor: `${sourceColor}20`, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: sourceColor, fontSize: 10, fontWeight: '600' }}>{sourceLabel}</Text>
            </View>
            {citation.pageNumber ? (
              <View style={{ backgroundColor: '#0984E320', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 4 }}>
                <Text style={{ color: '#0984E3', fontSize: 10, fontWeight: '600' }}>第{citation.pageNumber}页</Text>
              </View>
            ) : null}
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Feather name="x" size={18} color="#636E72" />
          </TouchableOpacity>
        </View>

        {/* Content */}
        {isMaterialPDF ? (
          <View style={styles.pdfContainer}>
            {citation.highlightText ? (
              <View style={styles.highlightBox}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                  <Text style={styles.highlightLabel}>引用内容：</Text>
                  {citation.pageNumber ? (
                    <Text style={{ fontSize: 11, color: '#0984E3', fontWeight: '600', marginLeft: 4 }}>
                      第{citation.pageNumber}页
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.highlightContent}>{citation.highlightText}</Text>
              </View>
            ) : null}
            <PDFViewer url={viewUrl} />
          </View>
        ) : (
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {loading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color="#6C63FF" />
              </View>
            ) : error ? (
              <Text style={styles.errorText}>{error}</Text>
            ) : (
              <>
                {citation.highlightText ? (
                  <View style={styles.highlightBox}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                      <Text style={styles.highlightLabel}>引用内容：</Text>
                      {citation.pageNumber ? (
                        <Text style={{ fontSize: 11, color: '#0984E3', fontWeight: '600', marginLeft: 4 }}>
                          第{citation.pageNumber}页
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.highlightContent}>{citation.highlightText}</Text>
                  </View>
                ) : null}
                <Text style={styles.contentText} selectable>
                  {content || '(无内容)'}
                </Text>
              </>
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 200,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  card: {
    width: CARD_WIDTH,
    maxHeight: '65%',
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 16,
    elevation: 20,
    overflow: 'hidden',
  },
  cardWide: {
    width: Math.min(SCREEN_WIDTH * 0.96, 420),
    maxHeight: '75%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F3',
    backgroundColor: '#FAFAFE',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2D3436',
    flex: 1,
  },
  closeBtn: {
    padding: 4,
  },
  highlightBox: {
    backgroundColor: '#FFF9C4',
    borderLeftWidth: 3,
    borderLeftColor: '#F9A825',
    borderRadius: 6,
    padding: 10,
    marginBottom: 12,
  },
  highlightLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#F57F17',
    marginBottom: 4,
  },
  highlightContent: {
    fontSize: 13,
    color: '#3E2723',
    lineHeight: 19,
  },
  pdfContainer: {
    height: 320,
    padding: 8,
  },
  content: {
    padding: 16,
    maxHeight: 300,
  },
  contentText: {
    fontSize: 14,
    color: '#2D3436',
    lineHeight: 22,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 30,
  },
  errorText: {
    fontSize: 13,
    color: '#FF3B30',
    textAlign: 'center',
    paddingVertical: 20,
  },
});
