import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Alert,
  Image,
  ActivityIndicator,
  Platform,
  Keyboard,
  ScrollView,
} from 'react-native';
import { useCallback, useState, useRef, useEffect } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSafeSearchParams } from '@/hooks/useSafeRouter';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import MarkdownRenderer from '@/components/MarkdownRenderer';

// ========== 类型 ==========
interface TextBlock {
  id: string;
  type: 'text';
  content: string;
}
interface ImageBlock {
  id: string;
  type: 'image';
  uri: string;
  name: string;
}
interface FileBlock {
  id: string;
  type: 'file';
  uri: string;
  name: string;
}
type Block = TextBlock | ImageBlock | FileBlock;

// ========== ID 生成 ==========
let _counter = 0;
const uid = () => { _counter++; return `b${Date.now()}_${_counter}`; };

// ========== 颜色 ==========
const C = {
  bg: '#FFFFFF',
  primary: '#6C63FF',
  text: '#1A1A1A',
  textSecondary: '#8E8E93',
  placeholder: '#C0C0C0',
  border: '#E8E8ED',
  fileBg: '#F2F2F7',
  danger: '#FF3B30',
  chipBg: '#F0EDFF',
};

export default function StudyNoteEditScreen() {
  const { id } = useSafeSearchParams<{ id: string }>();
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<'edit' | 'read'>('edit');
  const [listKey, setListKey] = useState(0);
  const [title, setTitle] = useState('');
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [papercore, setPapercore] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [logicalPath, setLogicalPath] = useState('');
  const [createdAt, setCreatedAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [blockHeights, setBlockHeights] = useState<Record<string, number>>({});

  const isNew = !id;

  // 每个文本块的 input ref（用于焦点管理）
  const inputRefs = useRef<Map<string, TextInput | null>>(new Map());

  // ========== 加载数据 ==========
  useFocusEffect(
    useCallback(() => {
      if (id) loadNote();
      else {
        setBlocks([{ id: uid(), type: 'text', content: '' }]);
        setLoading(false);
        setMode('edit');
        setTimeout(() => {
          const firstBlock = blocksRef.current[0];
          if (firstBlock && firstBlock.type === 'text') {
            inputRefs.current.get(firstBlock.id)?.focus();
          }
        }, 400);
      }
    }, [id])
  );

  // 用 ref 保持 blocks 最新值供回调使用
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const loadNote = async () => {
    try {
      const res = await api.getStudyNotes();
      const note = (res.data || []).find((n: any) => n.id === id);
      if (note) {
        setTitle(note.title || '');
        setPapercore(note.papercore || '');
        setTags(note.tags || []);
        setLogicalPath(note.logical_path || '');
        setCreatedAt(note.created_at || '');

        // 解析 blocks
        let parsed: Block[] = [];
        if (note.blocks && Array.isArray(note.blocks) && note.blocks.length > 0) {
          parsed = note.blocks.map((b: any) => ({ ...b, id: b.id || uid() }));
        } else if (note.content) {
          parsed = [{ id: uid(), type: 'text', content: note.content }];
        } else {
          parsed = [{ id: uid(), type: 'text', content: '' }];
        }
        // 兼容旧格式：单附件
        if (note.file_url && !parsed.some((b: any) => b.type === 'image' || b.type === 'file')) {
          const isImg = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(note.file_name || note.file_url);
          parsed.push({
            id: uid(),
            type: isImg ? 'image' : 'file',
            uri: note.file_url,
            name: note.file_name || '附件',
          } as Block);
        }
        setBlocks(parsed);

        // 已 AI 处理且未查看 → 自动进入阅读模式 + 标记已读
        if (note.ai_processed && !note.viewed_after_process) {
          setMode('read');
          api.markViewed('study_note', note.id).catch(() => {});
        } else {
          setMode('read');
        }
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  // ========== 块操作 ==========
  const insertBlockAfter = (afterId: string | null, block: Block) => {
    setBlocks(prev => {
      if (!afterId) {
        // 未聚焦任何块 → 插入末尾
        return [...prev, block];
      }
      const idx = prev.findIndex(b => b.id === afterId);
      if (idx === -1) return [...prev, block];
      const next = [...prev];
      next.splice(idx + 1, 0, block);
      return next;
    });
  };

  const removeBlock = (blockId: string) => {
    setBlocks(prev => {
      if (prev.length <= 1) return prev; // 至少保留一个块
      return prev.filter(b => b.id !== blockId);
    });
  };

  const updateTextBlock = (blockId: string, content: string) => {
    setBlocks(prev => prev.map(b => b.id === blockId && b.type === 'text' ? { ...b, content } : b));
  };

  // ========== 附件选择 ==========
  const handlePickImage = async () => {
    try {
      const p = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!p.granted) { Alert.alert('权限不足', '需要相册访问权限'); return; }
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.8 });
      if (!r.canceled && r.assets?.[0]) {
        const a = r.assets[0];
        insertBlockAfter(focusedBlockId, {
          id: uid(), type: 'image', uri: a.uri, name: a.fileName || '照片',
        });
      }
    } catch {}
  };

  const handlePickFile = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
      if (!r.canceled && r.assets?.[0]) {
        const a = r.assets[0];
        insertBlockAfter(focusedBlockId, {
          id: uid(), type: 'file', uri: a.uri, name: a.name || '文件',
        });
      }
    } catch {}
  };

  // ========== 保存 ==========
  const handleSave = async () => {
    const textBlocks = blocks.filter(b => b.type === 'text');
    const hasContent = textBlocks.some(b => b.content.trim()) || blocks.some(b => b.type === 'image' || b.type === 'file');
    if (!title.trim() && !hasContent) {
      Alert.alert('提示', '请填写内容');
      return;
    }
    setSaving(true);
    Keyboard.dismiss();

    try {
      // 上传新附件（本地 uri）并替换为远端 URL
      const resolvedBlocks: any[] = [];
      for (const b of blocks) {
        if ((b.type === 'image' || b.type === 'file') && !b.uri.startsWith('http')) {
          try {
            const up = await api.uploadFile(b.uri, b.name, b.type === 'image' ? 'image/jpeg' : 'application/octet-stream');
            resolvedBlocks.push({ ...b, uri: up.fileUrl, name: up.fileName || b.name });
          } catch {
            resolvedBlocks.push(b); // 上传失败也保留
          }
        } else {
          resolvedBlocks.push(b);
        }
      }

      const contentText = blocks
        .filter(b => b.type === 'text')
        .map(b => (b as TextBlock).content)
        .join('\n');

      const payload: any = {
        title: title || '学习便签',
        content: contentText,
        blocks: resolvedBlocks,
        tags,
        logical_path: logicalPath || undefined,
      };

      if (id) {
        await api.updateStudyNote(id, payload);
      } else {
        const cr = await api.createStudyNote(payload);
        const newId = cr?.data?.id;
        if (newId) {
          fetch(`${process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 'http://localhost:9091'}/api/v1/knowledge-builder/process-content`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'study_note', id: newId }),
          }).catch(() => {});
        }
      }

      Alert.alert('', '已存入知识库');
      setMode('read');
    } catch (e: any) {
      Alert.alert('错误', e.message || '保存失败');
    } finally { setSaving(false); }
  };

  // ========== 渲染辅助 ==========
  const formatDate = (s: string) => {
    if (!s) return '';
    const d = new Date(s);
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // ========== 格式化工具栏 ==========
  const formatButtons: { label: string; mark: string; multiline?: boolean }[] = [
    { label: 'H1', mark: '# ' },
    { label: 'H2', mark: '## ' },
    { label: 'H3', mark: '### ' },
    { label: 'H4', mark: '#### ' },
    { label: '• 列表', mark: '- ' },
    { label: '1. 列表', mark: '1. ' },
    { label: '> 引用', mark: '> ' },
    { label: '`代码`', mark: '`', multiline: true },
  ];

  const applyFormat = (mark: string, multiline?: boolean) => {
    const targetId = focusedBlockId || blocks.find(b => b.type === 'text')?.id;
    if (!targetId) {
      // No text block exists, create one
      const newBlock: TextBlock = { id: uid(), type: 'text', content: mark };
      setBlocks(prev => [...prev, newBlock]);
      setFocusedBlockId(newBlock.id);
      setTimeout(() => inputRefs.current.get(newBlock.id)?.focus(), 100);
      return;
    }
    setBlocks(prev => prev.map(b => {
      if (b.id !== targetId || b.type !== 'text') return b;
      const cur = b.content;
      if (multiline) {
        return { ...b, content: cur ? `${cur}\n${mark}${mark === '`' ? '' : ' '}` : mark };
      }
      return { ...b, content: cur ? `${cur}\n${mark}` : mark };
    }));
    // Re-focus the block
    setTimeout(() => inputRefs.current.get(targetId)?.focus(), 100);
  };

  // ========== 编辑模式块渲染 ==========
  const renderEditBlock = ({ item, drag, isActive }: RenderItemParams<Block>) => {
    if (item.type === 'text') {
      return (
        <View style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          paddingVertical: 6,
          opacity: isActive ? 0.6 : 1,
        }}>
          <View style={{ flex: 1 }}>
            <TextInput
              ref={ref => { inputRefs.current.set(item.id, ref); }}
              style={{
                fontSize: 16,
                lineHeight: 26,
                color: C.text,
                minHeight: 80,
                height: Math.max(80, blockHeights[item.id] || 0),
                padding: 0,
                textAlignVertical: 'top',
              }}
              placeholder="今天学到了什么？写下你的理解…"
              placeholderTextColor={C.placeholder}
              value={item.content}
              onChangeText={text => updateTextBlock(item.id, text)}
              onFocus={() => setFocusedBlockId(item.id)}
              onBlur={() => { if (focusedBlockId === item.id) setFocusedBlockId(null); }}
              multiline
              textAlignVertical="top"
              scrollEnabled={false}
              onContentSizeChange={(e) => {
                const h = e.nativeEvent.contentSize.height;
                if (blockHeights[item.id] !== h) {
                  setBlockHeights(prev => ({ ...prev, [item.id]: h }));
                }
              }}
            />
          </View>
          <TouchableOpacity
            onLongPress={drag}
            delayLongPress={150}
            style={{ padding: 8, marginTop: 4 }}
          >
            <Feather name="more-vertical" size={16} color={C.placeholder} />
          </TouchableOpacity>
        </View>
      );
    }

    if (item.type === 'image') {
      return (
        <View style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          paddingVertical: 8,
          opacity: isActive ? 0.6 : 1,
        }}>
          <View style={{ flex: 1 }}>
            <Image
              source={{ uri: item.uri }}
              style={{
                width: '100%',
                maxWidth: 300,
                height: 180,
                borderRadius: 12,
                backgroundColor: '#F2F2F7',
              }}
              resizeMode="cover"
            />
            <Text style={{ fontSize: 11, color: C.textSecondary, marginTop: 4 }}>{item.name}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
            <TouchableOpacity
              onPress={() => removeBlock(item.id)}
              style={{ padding: 8 }}
            >
              <Feather name="x" size={18} color={C.danger} />
            </TouchableOpacity>
            <TouchableOpacity onLongPress={drag} delayLongPress={150} style={{ padding: 8 }}>
              <Feather name="more-vertical" size={16} color={C.placeholder} />
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    if (item.type === 'file') {
      return (
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 8,
          backgroundColor: C.fileBg,
          borderRadius: 12,
          paddingHorizontal: 14,
          marginVertical: 4,
          opacity: isActive ? 0.6 : 1,
        }}>
          <Feather name="file-text" size={24} color="#FF9F43" />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ fontSize: 14, color: C.text, fontWeight: '500' }} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={{ fontSize: 11, color: C.textSecondary, marginTop: 2 }}>文件</Text>
          </View>
          <View style={{ flexDirection: 'row' }}>
            <TouchableOpacity onPress={() => removeBlock(item.id)} style={{ padding: 8 }}>
              <Feather name="x" size={18} color={C.danger} />
            </TouchableOpacity>
            <TouchableOpacity onLongPress={drag} delayLongPress={150} style={{ padding: 8 }}>
              <Feather name="more-vertical" size={16} color={C.placeholder} />
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    return null;
  };

  // ========== 阅读模式块渲染 ==========
  const renderReadBlock = ({ item, isActive }: RenderItemParams<Block>) => {
    if (item.type === 'text') {
      return (
        <View style={{
          paddingVertical: 6,
          opacity: isActive ? 0.6 : 1,
        }}>
          <MarkdownRenderer content={item.content || ' '} maxWidth={350} />
        </View>
      );
    }

    if (item.type === 'image') {
      return (
        <View style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          paddingVertical: 8,
          opacity: isActive ? 0.6 : 1,
        }}>
          <View style={{ flex: 1 }}>
            <Image
              source={{ uri: item.uri }}
              style={{
                width: '100%',
                maxWidth: 300,
                height: 180,
                borderRadius: 12,
                backgroundColor: '#F2F2F7',
              }}
              resizeMode="cover"
            />
            <Text style={{ fontSize: 11, color: C.textSecondary, marginTop: 4 }}>{item.name}</Text>
          </View>
        </View>
      );
    }

    if (item.type === 'file') {
      return (
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 8,
          backgroundColor: C.fileBg,
          borderRadius: 12,
          paddingHorizontal: 14,
          marginVertical: 4,
          opacity: isActive ? 0.6 : 1,
        }}>
          <Feather name="file-text" size={24} color="#FF9F43" />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ fontSize: 14, color: C.text, fontWeight: '500' }} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={{ fontSize: 11, color: C.textSecondary, marginTop: 2 }}>文件</Text>
          </View>
          <Feather name="chevron-right" size={18} color={C.placeholder} />
        </View>
      );
    }

    return null;
  };

  // ========== Loading ==========
  if (loading) {
    return (
      <Screen backgroundColor={C.bg}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      </Screen>
    );
  }

  // ========== 主渲染 ==========
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Screen backgroundColor={C.bg} safeAreaEdges={['left', 'right', 'bottom']}>
        <View style={{ flex: 1, backgroundColor: C.bg }}>
          {/* ======== 顶部导航 ======== */}
          <View style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 16,
            paddingBottom: 8,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottomWidth: 1,
            borderBottomColor: C.border,
          }}>
            {/* 左侧：返回 + 模式切换 */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
                <Feather name="arrow-left" size={22} color={C.text} />
              </TouchableOpacity>

              {/* 编辑/阅读 切换按钮 */}
              <TouchableOpacity
                onPress={() => { setMode(mode === 'edit' ? 'read' : 'edit'); setListKey(k => k + 1); }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 16,
                  backgroundColor: mode === 'edit' ? C.chipBg : '#F2F2F7',
                  borderWidth: 1,
                  borderColor: mode === 'edit' ? C.primary : C.border,
                }}
              >
                <Feather
                  name={mode === 'edit' ? 'edit-2' : 'book-open'}
                  size={13}
                  color={mode === 'edit' ? C.primary : C.textSecondary}
                />
                <Text style={{
                  fontSize: 13, fontWeight: '600',
                  color: mode === 'edit' ? C.primary : C.textSecondary,
                }}>
                  {mode === 'edit' ? '编辑' : '阅读'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* 右侧：保存按钮 */}
            {mode === 'edit' && (
              <TouchableOpacity
                onPress={handleSave}
                disabled={saving}
                style={{
                  backgroundColor: saving ? '#C7C4FF' : C.primary,
                  paddingHorizontal: 20,
                  paddingVertical: 8,
                  borderRadius: 20,
                }}
              >
                {saving ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 14 }}>保存</Text>
                )}
              </TouchableOpacity>
            )}
          </View>

          {/* ======== 固定标题区（下滑时保持可见） ======== */}
          <View style={{
            paddingHorizontal: 20,
            paddingBottom: 8,
            borderBottomWidth: 1,
            borderBottomColor: C.border,
            backgroundColor: C.bg,
          }}>
            {mode === 'edit' ? (
              <TextInput
                style={{
                  fontSize: 20,
                  fontWeight: '700',
                  color: C.text,
                  paddingVertical: 12,
                  marginTop: 4,
                }}
                placeholder="输入标题..."
                placeholderTextColor={C.placeholder}
                value={title}
                onChangeText={setTitle}
              />
            ) : (
              <Text style={{
                fontSize: 20,
                fontWeight: '700',
                color: C.text,
                paddingVertical: 12,
                marginTop: 4,
              }} numberOfLines={2}>
                {title || '未命名纪要'}
              </Text>
            )}

            {/* 日期（阅读模式） */}
            {mode === 'read' && createdAt ? (
              <Text style={{ fontSize: 12, color: C.textSecondary, marginTop: -4, marginBottom: 4 }}>
                {formatDate(createdAt)}
              </Text>
            ) : null}

            {/* AI 编排 Banner（阅读模式） */}
            {mode === 'read' && tags.length > 0 && logicalPath ? (
              <View style={{
                backgroundColor: '#F0EDFF',
                borderRadius: 10,
                padding: 10,
                marginBottom: 4,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}>
                <Text style={{ fontSize: 12 }}>✅</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, fontWeight: '600', color: C.primary }}>AI 已自动编排</Text>
                  <Text style={{ fontSize: 10, color: C.textSecondary, marginTop: 2 }} numberOfLines={1}>{logicalPath}</Text>
                </View>
              </View>
            ) : null}
          </View>

          {/* ======== 可滚动块列表 ======== */}
          <View style={{ flex: 1 }}>
            {mode === 'edit' ? (
              <DraggableFlatList
                key={`edit-${listKey}`}
                data={blocks}
                renderItem={renderEditBlock}
                keyExtractor={(item: Block) => item.id}
                onDragEnd={({ data }: { data: Block[] }) => setBlocks(data)}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 140 }}
                ListHeaderComponent={<View style={{ height: 8 }} />}
              />
            ) : (
              <DraggableFlatList
                key={`read-${listKey}`}
                data={blocks}
                renderItem={renderReadBlock}
                keyExtractor={(item: Block) => item.id}
                onDragEnd={({ data }: { data: Block[] }) => setBlocks(data)}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
                ListHeaderComponent={<View style={{ height: 8 }} />}
                ListFooterComponent={
                <View>
                  {/* Papercore（阅读模式） */}
                  {mode === 'read' && papercore ? (
                    <View style={{
                      backgroundColor: '#FFF8F0',
                      borderRadius: 12,
                      padding: 16,
                      marginTop: 20,
                      borderLeftWidth: 4,
                      borderLeftColor: '#FF9F43',
                    }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: '#FF9F43', marginBottom: 6 }}>Papercore 摘要</Text>
                      <Text style={{ fontSize: 14, color: C.text, lineHeight: 22 }}>{papercore}</Text>
                    </View>
                  ) : null}

                  {/* 标签（阅读模式） */}
                  {mode === 'read' && tags.length > 0 ? (
                    <View style={{ marginTop: 20 }}>
                      <Text style={{ fontSize: 12, fontWeight: '700', color: C.textSecondary, marginBottom: 8 }}>知识标签</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {tags.map((tag, i) => {
                          const levelColors = [
                            { bg: '#6C63FF', fg: '#FFF' },
                            { bg: 'rgba(108,99,255,0.2)', fg: '#6C63FF' },
                            { bg: 'rgba(108,99,255,0.08)', fg: '#8B83FF' },
                          ];
                          const lc = levelColors[Math.min(i, 2)];
                          return (
                            <View key={i} style={{
                              backgroundColor: lc.bg,
                              paddingHorizontal: 12,
                              paddingVertical: 6,
                              borderRadius: 8,
                            }}>
                              <Text style={{ fontSize: 12, fontWeight: '600', color: lc.fg }}>
                                {['📐 ', '📂 ', '📌 '][Math.min(i, 2)]}{tag}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  ) : null}

                  {/* 逻辑路径（阅读模式） */}
                  {mode === 'read' && logicalPath ? (
                    <View style={{ marginTop: 16, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Feather name="folder" size={14} color="#FF9F43" />
                      <Text style={{ fontSize: 12, color: '#FF9F43', fontWeight: '500' }}>{logicalPath}</Text>
                    </View>
                  ) : null}

                  {/* 底部留白：给操作栏让位 */}
                  <View style={{ height: 40 }} />
                </View>
              }
            />
            )}
          </View>

          {/* ======== 底部操作栏（仅编辑模式） ======== */}
          {mode === 'edit' && (
            <View style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              backgroundColor: C.bg,
              borderTopWidth: 1,
              borderTopColor: C.border,
              paddingBottom: insets.bottom + 8,
            }}>
              {/* 格式化工具栏 */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingVertical: 8,
                  gap: 6,
                }}
              >
                {formatButtons.map((btn) => (
                  <TouchableOpacity
                    key={btn.label}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 8,
                      backgroundColor: C.fileBg,
                      borderWidth: 1,
                      borderColor: C.border,
                    }}
                    onPress={() => applyFormat(btn.mark, btn.multiline)}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '600', color: C.textSecondary }}>
                      {btn.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* 附件按钮行 */}
              <View style={{
                flexDirection: 'row',
                gap: 20,
                paddingHorizontal: 20,
                paddingTop: 4,
              }}>
                <TouchableOpacity
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                    borderRadius: 12,
                    backgroundColor: C.fileBg,
                  }}
                  onPress={handlePickImage}
                >
                  <Feather name="camera" size={20} color={C.primary} />
                  <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>相册</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingVertical: 10,
                    paddingHorizontal: 16,
                    borderRadius: 12,
                    backgroundColor: C.fileBg,
                  }}
                  onPress={handlePickFile}
                >
                  <Feather name="paperclip" size={20} color="#FF9F43" />
                  <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>文件</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Screen>
    </GestureHandlerRootView>
  );
}
