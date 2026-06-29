import { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Modal,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import MarkdownRenderer from '@/components/markdown/MarkdownRenderer';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

export type SourceFile = {
  id: string;
  type: 'study_note' | 'material';
  title: string;
  logicalPath?: string;
};

export type Citation = {
  index: number;
  sourceId: string;
  sourceType: string;
  fileName: string;
  highlightText?: string;
};

type NoteHelperPanelProps = {
  visible: boolean;
  onClose: () => void;
  /** 选中的源文件列表 */
  sourceFiles: SourceFile[];
  /** SSE 流式生成回调 — 返回 Promise 解析为完整笔记 */
  onGenerate: (signal: { aborted: boolean }) => Promise<{
    content: string;
    citations: Citation[];
  } | null>;
};

export default function NoteHelperPanel({
  visible,
  onClose,
  sourceFiles,
  onGenerate,
}: NoteHelperPanelProps) {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<'idle' | 'generating' | 'done' | 'error'>('idle');
  const [noteContent, setNoteContent] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef({ aborted: false });

  // 当面板打开且有源文件时，自动开始生成
  useEffect(() => {
    if (visible && sourceFiles.length > 0 && status === 'idle') {
      startGeneration();
    }
  }, [visible, sourceFiles]);

  // 面板关闭时重置
  useEffect(() => {
    if (!visible) {
      // 延迟重置，让关闭动画先播放
      const t = setTimeout(() => {
        setStatus('idle');
        setNoteContent('');
        setCitations([]);
        setErrorMsg('');
        abortRef.current.aborted = false;
      }, 300);
      return () => clearTimeout(t);
    }
  }, [visible]);

  const startGeneration = async () => {
    setStatus('generating');
    setNoteContent('');
    setErrorMsg('');
    abortRef.current.aborted = false;

    try {
      const result = await onGenerate(abortRef.current);
      if (abortRef.current.aborted) return;

      if (result) {
        setNoteContent(result.content);
        setCitations(result.citations || []);
        setStatus('done');
      } else {
        setStatus('error');
        setErrorMsg('生成失败，请重试');
      }
    } catch (e: any) {
      if (!abortRef.current.aborted) {
        setStatus('error');
        setErrorMsg(e.message || '网络错误');
      }
    }
  };

  const handleFullscreen = () => {
    if (noteContent && citations.length >= 0) {
      router.push('/note-helper-fullscreen', {
        noteContent,
        citations: JSON.stringify(citations),
        sourceFiles: JSON.stringify(sourceFiles),
      });
      onClose();
    }
  };

  const sourceCount = sourceFiles.length;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} onPress={onClose} activeOpacity={1} />
        <View
          style={[
            styles.panel,
            { paddingBottom: insets.bottom + 16 },
          ]}
        >
          {/* Handle bar */}
          <View style={styles.handleBar}>
            <View style={styles.handle} />
          </View>

          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              {status === 'generating' ? (
                <ActivityIndicator size="small" color="#6C63FF" />
              ) : status === 'done' ? (
                <Feather name="check-circle" size={20} color="#00B894" />
              ) : null}
              <Text style={styles.headerTitle}>
                {status === 'generating'
                  ? `正在生成笔记... (${sourceCount} 个文件)`
                  : status === 'done'
                  ? `已生成 (${sourceCount} 个文件)`
                  : status === 'error'
                  ? '生成失败'
                  : `准备生成 (${sourceCount} 个文件)`}
              </Text>
            </View>
            <View style={styles.headerRight}>
              {status === 'done' && (
                <TouchableOpacity style={styles.fullscreenBtn} onPress={handleFullscreen}>
                  <Feather name="maximize-2" size={18} color="#6C63FF" />
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                <Feather name="x" size={20} color="#636E72" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Content */}
          <ScrollView
            ref={scrollRef}
            style={styles.content}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => {
              if (status === 'generating') {
                scrollRef.current?.scrollToEnd({ animated: true });
              }
            }}
          >
            {status === 'generating' && !noteContent && (
              <View style={styles.generatingPlaceholder}>
                <ActivityIndicator size="large" color="#6C63FF" />
                <Text style={styles.generatingText}>AI 正在分析源文件...</Text>
                <Text style={styles.generatingSubtext}>
                  正在读取 {sourceFiles.map(f => f.title).join('、')}
                </Text>
              </View>
            )}

            {status === 'generating' && noteContent && (
              <MarkdownRenderer content={noteContent + '▌'} maxWidth={SCREEN_HEIGHT * 0.5 - 40} />
            )}

            {status === 'done' && noteContent && (
              <>
                <MarkdownRenderer content={noteContent} maxWidth={SCREEN_HEIGHT * 0.5 - 40} />
                <View style={styles.doneHint}>
                  <Feather name="maximize-2" size={14} color="#6C63FF" />
                  <Text style={styles.doneHintText}>点击上方 ⛶ 进入全屏修改</Text>
                </View>
              </>
            )}

            {status === 'error' && (
              <View style={styles.errorState}>
                <Feather name="alert-circle" size={32} color="#FF3B30" />
                <Text style={styles.errorText}>{errorMsg}</Text>
                <TouchableOpacity style={styles.retryBtn} onPress={startGeneration}>
                  <Text style={styles.retryText}>重试</Text>
                </TouchableOpacity>
              </View>
            )}

            {status === 'idle' && (
              <View style={styles.generatingPlaceholder}>
                <Feather name="file-text" size={32} color="#B2BEC3" />
                <Text style={styles.generatingText}>已选择 {sourceCount} 个文件</Text>
                <Text style={styles.generatingSubtext}>点击下方按钮开始生成</Text>
                <TouchableOpacity style={styles.startBtn} onPress={startGeneration}>
                  <Feather name="zap" size={18} color="#FFF" />
                  <Text style={styles.startBtnText}>开始生成</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>

          {/* Bottom bar */}
          {status === 'done' && (
            <View style={styles.bottomBar}>
              <TouchableOpacity
                style={styles.fullscreenLargeBtn}
                onPress={handleFullscreen}
              >
                <Feather name="maximize-2" size={18} color="#FFF" />
                <Text style={styles.fullscreenLargeText}>全屏编辑</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const PANEL_HEIGHT = SCREEN_HEIGHT * 0.5;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  panel: {
    height: PANEL_HEIGHT,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 20,
  },
  handleBar: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 6,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E0E0E0',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F3',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#2D3436',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fullscreenBtn: {
    padding: 6,
    backgroundColor: '#F0EDFF',
    borderRadius: 8,
  },
  closeBtn: {
    padding: 6,
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  generatingPlaceholder: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  generatingText: {
    fontSize: 15,
    color: '#2D3436',
    fontWeight: '600',
    marginTop: 12,
  },
  generatingSubtext: {
    fontSize: 13,
    color: '#B2BEC3',
    marginTop: 6,
    textAlign: 'center',
  },
  doneHint: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 20,
  },
  doneHintText: {
    fontSize: 13,
    color: '#6C63FF',
    fontWeight: '500',
  },
  errorState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  errorText: {
    fontSize: 14,
    color: '#FF3B30',
    marginTop: 8,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: '#6C63FF',
    borderRadius: 12,
  },
  retryText: {
    color: '#FFF',
    fontWeight: '600',
  },
  startBtn: {
    marginTop: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#6C63FF',
    borderRadius: 16,
  },
  startBtnText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 15,
  },
  bottomBar: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#F0F0F3',
  },
  fullscreenLargeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#6C63FF',
    paddingVertical: 14,
    borderRadius: 16,
  },
  fullscreenLargeText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 16,
  },
});
