import { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  TextInput,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSafeSearchParams } from '@/hooks/useSafeRouter';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { Screen } from '@/components/layout/Screen';
import MarkdownRenderer from '@/components/markdown/MarkdownRenderer';
import NoteHelperSidebar from '@/components/note-helper/NoteHelperSidebar';
import ReferenceCard from '@/components/common/ReferenceCard';
import type { SourceFileMeta } from '@/components/note-helper/NoteHelperSidebar';
import type { Citation } from '@/components/common/ReferenceCard';
import { api } from '@/utils/api';

type SourceFile = {
  id: string;
  type: 'study_note' | 'material';
  title: string;
  logicalPath?: string;
};

const QUICK_ACTIONS = [
  { label: '更详细', icon: 'align-left' as const, prompt: '请把内容写得更详细，补充更多解释和背景。' },
  { label: '更简洁', icon: 'minimize-2' as const, prompt: '请把内容精简，只保留最核心的知识点。' },
  { label: '表格对比', icon: 'grid' as const, prompt: '请用表格形式整理关键概念的对比。' },
  { label: '举例子', icon: 'lightbulb' as const, prompt: '请为重要概念添加具体的例子帮助理解。' },
  { label: '突出重点', icon: 'star' as const, prompt: '请突出标记重点内容和易错点。' },
];

const COLORS = {
  bg: '#FFFFFF',
  primary: '#6C63FF',
  text: '#2D3436',
  textSecondary: '#636E72',
  textMuted: '#B2BEC3',
  border: '#F0F0F3',
};

export default function NoteHelperFullscreenScreen() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const params = useSafeSearchParams<{
    noteContent: string;
    citations: string;
    sourceFiles: string;
  }>();

  // Parse params
  const initialContent = params.noteContent || '';
  const parsedCitations: Citation[] = (() => {
    try { return JSON.parse(params.citations || '[]'); } catch { return []; }
  })();
  const parsedSourceFiles: SourceFile[] = (() => {
    try { return JSON.parse(params.sourceFiles || '[]'); } catch { return []; }
  })();

  const [noteContent, setNoteContent] = useState(initialContent);
  const [citations] = useState<Citation[]>(parsedCitations);
  const [sourceFiles] = useState<SourceFile[]>(parsedSourceFiles);

  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineInput, setRefineInput] = useState('');
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);
  const [saving, setSaving] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef({ aborted: false });

  // Source files with metadata for sidebar
  const sourceFilesMeta: SourceFileMeta[] = sourceFiles.map(f => ({
    id: f.id,
    type: f.type,
    title: f.title,
  }));

  // Handle citation tap
  const handleCitationTap = useCallback((citationIndex: number) => {
    const cit = citations.find(c => c.index === citationIndex);
    if (cit) {
      setActiveCitation(cit);
    }
  }, [citations]);

  // Handle refinement
  const handleRefine = async (prompt: string) => {
    if (!prompt.trim() || refining) return;
    setRefining(true);
    setRefineInput('');
    abortRef.current.aborted = false;

    try {
      let fullContent = '';
      await api.refineNoteStream(
        noteContent,
        prompt,
        sourceFiles,
        (chunk) => {
          fullContent += chunk;
          setNoteContent(fullContent);
        },
        undefined,
        abortRef.current,
      );
    } catch (e: any) {
      Alert.alert('修正失败', e.message || '网络错误');
    } finally {
      setRefining(false);
    }
  };

  // Handle save
  const handleSave = async () => {
    setSaving(true);
    try {
      const textBlocks = noteContent.split(/\n\n(?=#{1,4}\s)/);
      const blocks = textBlocks.map((content, i) => ({
        id: `b${Date.now()}_${i}`,
        type: 'text' as const,
        content,
      }));

      const sourceLogicalPath = sourceFiles.find(f => f.logicalPath)?.logicalPath;
      const res = await api.createStudyNote({
        title: sourceFiles.map(f => f.title).join(' + ') + ' 综合笔记',
        content: noteContent,
        blocks,
        tags: [],
        logical_path: sourceLogicalPath || undefined,
      });

      Alert.alert('保存成功', '笔记已保存到知识库');
      router.back();
    } catch (e: any) {
      Alert.alert('保存失败', e.message || '网络错误');
    } finally {
      setSaving(false);
    }
  };

  // Render citation markers in content
  const renderContent = () => {
    // Parse [来源:N] markers and make them tappable
    const parts = noteContent.split(/(\[来源:\d+\])/g);
    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {parts.map((part, i) => {
          const match = part.match(/^\[来源:(\d+)\]$/);
          if (match) {
            const idx = parseInt(match[1]);
            return (
              <TouchableOpacity
                key={i}
                onPress={() => handleCitationTap(idx)}
                style={styles.citationMarker}
              >
                <Text style={styles.citationMarkerText}>[{idx}]</Text>
              </TouchableOpacity>
            );
          }
          return (
            <View key={i}>
              <MarkdownRenderer content={part} maxWidth={SCREEN_WIDTH - 40} />
            </View>
          );
        })}
      </View>
    );
  };

  return (
    <Screen backgroundColor={COLORS.bg}>
      <View style={styles.container}>
        {/* Top Bar */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <View style={styles.topBarRow}>
            <View style={styles.topLeft}>
              <TouchableOpacity onPress={() => router.back()} style={styles.topBtn}>
                <Feather name="arrow-left" size={22} color={COLORS.text} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSidebarVisible(true)} style={styles.topBtn}>
                <Feather name="menu" size={22} color={COLORS.text} />
              </TouchableOpacity>
              <Text style={styles.topTitle} numberOfLines={1}>
                生成的笔记
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Feather name="save" size={16} color="#FFF" />
                  <Text style={styles.saveBtnText}>保存</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Note Content */}
        <ScrollView
          ref={scrollRef}
          style={styles.noteContent}
          contentContainerStyle={styles.noteContentInner}
          showsVerticalScrollIndicator={false}
        >
          {noteContent ? renderContent() : (
            <View style={styles.emptyState}>
              <Feather name="file-text" size={48} color={COLORS.textMuted} />
              <Text style={styles.emptyText}>暂无笔记内容</Text>
            </View>
          )}
          <View style={{ height: 20 }} />
        </ScrollView>

        {/* Bottom Refinement Bar */}
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 8 }]}>
          {/* Quick Actions */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.quickActionsContainer}
          >
            {QUICK_ACTIONS.map((action, i) => (
              <TouchableOpacity
                key={i}
                style={[styles.quickBtn, refining && styles.quickBtnDisabled]}
                onPress={() => handleRefine(action.prompt)}
                disabled={refining}
              >
                <Feather name={action.icon} size={14} color={refining ? COLORS.textMuted : COLORS.primary} />
                <Text style={[styles.quickBtnText, refining && styles.quickBtnTextDisabled]}>
                  {action.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Free text input */}
          <View style={styles.refineInputContainer}>
            <TextInput
              style={styles.refineInput}
              placeholder="输入修改需求..."
              placeholderTextColor={COLORS.textMuted}
              value={refineInput}
              onChangeText={setRefineInput}
              multiline
              maxLength={500}
              editable={!refining}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!refineInput.trim() || refining) && styles.sendBtnDisabled]}
              onPress={() => handleRefine(refineInput)}
              disabled={!refineInput.trim() || refining}
            >
              {refining ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <Feather name="send" size={18} color="#FFF" />
              )}
            </TouchableOpacity>
          </View>
        </View>

        {/* Sidebar */}
        <NoteHelperSidebar
          visible={sidebarVisible}
          onClose={() => setSidebarVisible(false)}
          sourceFiles={sourceFilesMeta}
          citations={citations}
        />

        {/* Reference Card */}
        <ReferenceCard
          citation={activeCitation}
          visible={!!activeCitation}
          onClose={() => setActiveCitation(null)}
        />
      </View>
    </Screen>
  );
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  topBar: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F3',
    backgroundColor: '#FFFFFF',
  },
  topBarRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  topLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  topBtn: {
    padding: 8,
  },
  topTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#2D3436',
    flex: 1,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#6C63FF',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  saveBtnDisabled: {
    backgroundColor: '#C7C4FF',
  },
  saveBtnText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 14,
  },
  noteContent: {
    flex: 1,
  },
  noteContentInner: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 15,
    color: '#B2BEC3',
    marginTop: 12,
  },
  bottomBar: {
    borderTopWidth: 1,
    borderTopColor: '#F0F0F3',
    backgroundColor: '#FFFFFF',
  },
  quickActionsContainer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  quickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#F0EDFF',
    borderWidth: 1,
    borderColor: '#E8E3FF',
  },
  quickBtnDisabled: {
    backgroundColor: '#F0F0F3',
    borderColor: '#E8E8ED',
  },
  quickBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6C63FF',
  },
  quickBtnTextDisabled: {
    color: '#B2BEC3',
  },
  refineInputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 8,
    gap: 8,
  },
  refineInput: {
    flex: 1,
    backgroundColor: '#F0F0F3',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    color: '#2D3436',
    maxHeight: 80,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#6C63FF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: {
    backgroundColor: '#C7C4FF',
  },
  citationMarker: {
    backgroundColor: '#F0EDFF',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginHorizontal: 1,
  },
  citationMarkerText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6C63FF',
  },
});
