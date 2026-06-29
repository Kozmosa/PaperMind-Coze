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
import MarkdownRenderer from '@/components/markdown/MarkdownRenderer';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SIDEBAR_WIDTH = SCREEN_WIDTH * 0.85;

export type SourceFileMeta = {
  id: string;
  type: 'study_note' | 'material';
  title: string;
  date?: string;
  pages?: number;
  citations?: number;
};

type NoteHelperSidebarProps = {
  visible: boolean;
  onClose: () => void;
  sourceFiles: SourceFileMeta[];
  citations: { index: number; sourceId: string; sourceType: string; fileName: string }[];
};

function SidebarPDFViewer({ url }: { url: string }) {
  if (Platform.OS === 'web') {
    return (
      <iframe
        src={url}
        style={{ width: '100%', height: '100%', border: 'none' }}
        title="Source PDF"
      />
    );
  }

  try {
    const WebView = require('react-native-webview').WebView;
    return (
      <WebView
        source={{ uri: url }}
        style={{ flex: 1, backgroundColor: 'transparent' }}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowFileAccess={true}
        allowUniversalAccessFromFileURLs={true}
        mixedContentMode="always"
        startInLoadingState={true}
        renderLoading={() => (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#6C63FF" />
          </View>
        )}
      />
    );
  } catch {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <Feather name="file" size={40} color="#B2BEC3" />
        <Text style={{ color: '#B2BEC3', marginTop: 8 }}>PDF 预览需要 WebView 支持</Text>
      </View>
    );
  }
}

export default function NoteHelperSidebar({
  visible,
  onClose,
  sourceFiles,
  citations,
}: NoteHelperSidebarProps) {
  const [selectedFile, setSelectedFile] = useState<SourceFileMeta | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [fileViewUrl, setFileViewUrl] = useState<string>('');
  const [loadingContent, setLoadingContent] = useState(false);

  // Reset when closed
  useEffect(() => {
    if (!visible) {
      setSelectedFile(null);
      setFileContent('');
      setFileViewUrl('');
    }
  }, [visible]);

  const handleSelectFile = async (file: SourceFileMeta) => {
    setSelectedFile(file);
    setLoadingContent(true);
    setFileContent('');
    setFileViewUrl('');
    try {
      const res = await api.getSourceFileContent(file.id, file.type);
      const data = res.data;
      if (data) {
        if (file.type === 'study_note') {
          // study_notes returns the note object directly
          let content = data.content || '';
          if (data.blocks && Array.isArray(data.blocks)) {
            content = data.blocks
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.content || '')
              .join('\n\n');
          }
          setFileContent(content || '(无内容)');
        } else {
          // materials: prefer original file viewUrl over OCR text
          if (data.viewUrl) {
            setFileViewUrl(data.viewUrl);
          } else if (data.pages && Array.isArray(data.pages)) {
            setFileContent(data.pages.map((p: any) => p.text || '').join('\n\n'));
          } else if (data.content) {
            setFileContent(data.content);
          } else {
            setFileContent('(文件内容不可用 — 可能是 PDF 或 PPT 二进制文件)');
          }
        }
      }
    } catch (e) {
      setFileContent('加载失败');
    } finally {
      setLoadingContent(false);
    }
  };

  // Count citations per source
  const getCitationCount = (fileId: string) => {
    return citations.filter(c => c.sourceId === fileId).length;
  };

  if (!visible) return null;

  return (
    <View style={styles.container}>
      {/* Backdrop */}
      <TouchableOpacity style={styles.backdrop} onPress={onClose} activeOpacity={1} />

      {/* Sidebar */}
      <View style={styles.sidebar}>
        {/* Header */}
        <View style={styles.header}>
          {selectedFile ? (
            <View style={styles.headerRow}>
              <TouchableOpacity onPress={() => { setSelectedFile(null); setFileContent(''); }}>
                <Feather name="arrow-left" size={22} color="#2D3436" />
              </TouchableOpacity>
              <Text style={styles.headerTitle} numberOfLines={1}>
                {selectedFile.title}
              </Text>
              <TouchableOpacity onPress={onClose}>
                <Feather name="x" size={22} color="#636E72" />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.headerRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Feather name="book-open" size={20} color="#6C63FF" />
                <Text style={styles.headerTitle}>源文件 ({sourceFiles.length})</Text>
              </View>
              <TouchableOpacity onPress={onClose}>
                <Feather name="x" size={22} color="#636E72" />
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Content */}
        {selectedFile ? (
          fileViewUrl ? (
            <SidebarPDFViewer url={fileViewUrl} />
          ) : (
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {loadingContent ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color="#6C63FF" />
                <Text style={styles.loadingText}>加载中...</Text>
              </View>
            ) : (
              <>
                {/* File meta info */}
                <View style={styles.fileMeta}>
                  <View style={styles.fileMetaRow}>
                    <Feather
                      name={selectedFile.type === 'study_note' ? 'edit-3' : 'file-text'}
                      size={14}
                      color={selectedFile.type === 'study_note' ? '#00B894' : '#FF9F43'}
                    />
                    <Text style={styles.fileMetaText}>
                      {selectedFile.type === 'study_note' ? '学习纪要' : '资料'}
                    </Text>
                    {selectedFile.date && (
                      <Text style={styles.fileMetaText}> · {selectedFile.date}</Text>
                    )}
                  </View>
                </View>
                {/* Content */}
                {fileContent.length > 500 ? (
                  <MarkdownRenderer content={fileContent} maxWidth={SIDEBAR_WIDTH - 40} />
                ) : (
                  <Text style={styles.fileContentText}>{fileContent}</Text>
                )}
                <View style={{ height: 40 }} />
              </>
            )}
          </ScrollView>
          )
        ) : (
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {sourceFiles.map((file) => {
              const citeCount = getCitationCount(file.id);
              return (
                <TouchableOpacity
                  key={`${file.type}_${file.id}`}
                  style={styles.fileItem}
                  onPress={() => handleSelectFile(file)}
                >
                  <View style={styles.fileIcon}>
                    <Feather
                      name={file.type === 'study_note' ? 'edit-3' : 'file-text'}
                      size={20}
                      color={file.type === 'study_note' ? '#00B894' : '#FF9F43'}
                    />
                  </View>
                  <View style={styles.fileInfo}>
                    <Text style={styles.fileName} numberOfLines={1}>
                      {file.title}
                    </Text>
                    <Text style={styles.fileSubtitle}>
                      {file.date || ''}
                      {file.type === 'material' && file.pages ? ` · ${file.pages}页` : ''}
                      {citeCount > 0 ? ` · 引用 ${citeCount} 处` : ''}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={16} color="#B2BEC3" />
                </TouchableOpacity>
              );
            })}
            {sourceFiles.length === 0 && (
              <View style={styles.emptyState}>
                <Feather name="folder-open" size={40} color="#B2BEC3" />
                <Text style={styles.emptyText}>暂无源文件</Text>
              </View>
            )}
            <View style={{ height: 40 }} />
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    flexDirection: 'row',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  sidebar: {
    width: SIDEBAR_WIDTH,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 10,
  },
  header: {
    paddingTop: Platform.OS === 'ios' ? 56 : 40,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F3',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2D3436',
    flex: 1,
    marginHorizontal: 12,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F3',
    gap: 12,
  },
  fileIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#F8F9FA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2D3436',
  },
  fileSubtitle: {
    fontSize: 12,
    color: '#B2BEC3',
    marginTop: 2,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 14,
    color: '#B2BEC3',
    marginTop: 12,
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  loadingText: {
    fontSize: 13,
    color: '#B2BEC3',
    marginTop: 8,
  },
  fileMeta: {
    paddingVertical: 8,
    marginBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F3',
  },
  fileMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  fileMetaText: {
    fontSize: 12,
    color: '#636E72',
  },
  fileContentText: {
    fontSize: 14,
    color: '#2D3436',
    lineHeight: 22,
  },
});
