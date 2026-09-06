import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useCSSVariable } from 'uniwind';
import { Screen } from '@/components/layout/Screen';
import { api } from '@/utils/api';
import { noWebResize } from '@/utils';

// ========== 颜色（与 study-note-edit 保持一致） ==========
const C = {
  primary: '#6C63FF',
  text: '#1A1A1A',
  textSecondary: '#8E8E93',
  placeholder: '#C0C0C0',
  border: '#E8E8ED',
  fileBg: '#F2F2F7',
  danger: '#FF3B30',
  chipBg: '#F0EDFF',
};

interface RelationSuggestion {
  nodeId: number;
  short_name: string;
  papercore: string;
  tags: string[];
  relation_type: string;
  score: number;
}

const RELATION_LABELS: Record<string, string> = {
  prerequisite: '前置知识',
  related: '相关知识',
  parent: '上层概念',
};

const stripHash = (t: string) => t.trim().replace(/^#+/, '');

export default function KnowledgeNodeEditScreen() {
  const { draftId, nodeId } = useSafeSearchParams<{ draftId?: number; nodeId?: number }>();
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const [background] = useCSSVariable(['--color-background']) as string[];
  const pageBg = background || '#F0F0F3';

  const [shortName, setShortName] = useState('');
  const [papercore, setPapercore] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [draftName, setDraftName] = useState('');

  const [suggestions, setSuggestions] = useState<RelationSuggestion[]>([]);
  const [confirmedRelations, setConfirmedRelations] = useState<Set<number>>(new Set());
  const [ignoredRelations, setIgnoredRelations] = useState<Set<number>>(new Set());

  const [loading, setLoading] = useState(!!nodeId);
  const [saving, setSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState('');
  const [loadingRelations, setLoadingRelations] = useState(false);

  const isEdit = !!nodeId;

  // ========== 初始加载 ==========
  useEffect(() => {
    (async () => {
      try {
        if (nodeId) {
          const res = await api.getKnowledgeNode(nodeId);
          const node = res.data;
          if (node) {
            setShortName(node.short_name || '');
            setPapercore(node.papercore || '');
            setTags((node.tags || []).map(stripHash));
          }
        }
        if (draftId) {
          const res = await api.getDrafts();
          const draft = (res.data || []).find((d: any) => d.id === draftId);
          if (draft) setDraftName(draft.file_name || `草稿 #${draftId}`);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [nodeId, draftId]);

  // ========== 标签 ==========
  const addTag = () => {
    const t = stripHash(tagInput);
    if (!t) return;
    if (!tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagInput('');
  };

  const removeTag = (t: string) => setTags((prev) => prev.filter((x) => x !== t));

  // ========== AI 生成字段 ==========
  const aiFill = async (field: 'short_name' | 'papercore' | 'tags') => {
    if (aiLoading) return;
    setAiLoading(field);
    try {
      const draftIds = draftId ? [draftId] : undefined;
      const currentContent = papercore.trim() || shortName.trim() || undefined;
      const text = await api.suggest(field, draftIds, currentContent);
      if (!text) return;
      if (field === 'short_name') {
        setShortName(
          text
            .replace(/^["「『]|["」』]$/g, '')
            .trim()
            .slice(0, 12),
        );
      } else if (field === 'papercore') {
        setPapercore(text.trim());
      } else {
        const parsed = text
          .split(/[,，、\s]+/)
          .map(stripHash)
          .filter(Boolean);
        if (parsed.length > 0) setTags(parsed);
      }
    } catch (e: any) {
      Alert.alert('AI 生成失败', e.message || '请检查网络连接');
    } finally {
      setAiLoading('');
    }
  };

  // ========== 关联推荐 ==========
  const handleGetRelations = async () => {
    if (!papercore.trim()) {
      Alert.alert('提示', '请先填写 Papercore');
      return;
    }
    setLoadingRelations(true);
    try {
      const res = await api.suggestRelations(
        papercore,
        tags.map((t) => `#${t}`),
      );
      setSuggestions((res.data as any)?.suggestions || []);
      setConfirmedRelations(new Set());
      setIgnoredRelations(new Set());
    } catch (e: any) {
      console.error('Suggest relations failed:', e);
      Alert.alert('获取关联失败', e.message || '请检查网络连接');
    } finally {
      setLoadingRelations(false);
    }
  };

  const toggleConfirm = (id: number) => {
    setConfirmedRelations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setIgnoredRelations((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const toggleIgnore = (id: number) => {
    setIgnoredRelations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmedRelations((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // ========== 保存 ==========
  const handleSave = async () => {
    if (!papercore.trim()) {
      Alert.alert('提示', 'Papercore 不能为空');
      return;
    }
    setSaving(true);
    try {
      const relations: Record<string, number[]> = {};
      suggestions
        .filter((s) => confirmedRelations.has(s.nodeId))
        .forEach((s) => {
          if (!relations[s.relation_type]) relations[s.relation_type] = [];
          relations[s.relation_type].push(s.nodeId);
        });

      const payload: any = {
        papercore: papercore.trim(),
        short_name: shortName.trim() || papercore.trim().substring(0, 8),
        tags: tags.map((t) => `#${t}`),
        relations,
      };
      if (draftId) payload.attached_draft_ids = [draftId];

      if (isEdit) {
        await api.updateKnowledgeNode(nodeId, payload);
      } else {
        await api.createKnowledgeNode(payload);
      }

      // 从草稿池「处理为节点」进入时，回写草稿状态
      if (draftId && !isEdit) {
        api.updateDraftStatus(draftId, { status: 'processed' }).catch(() => undefined);
      }

      Alert.alert('保存成功', isEdit ? '知识节点已更新' : '知识节点已创建', [
        { text: '返回', onPress: () => router.back() },
        { text: '查看知识图谱', onPress: () => router.replace('/knowledge') },
      ]);
    } catch (e: any) {
      console.error('Save failed:', e);
      Alert.alert('保存失败', e.message || '请重试');
    } finally {
      setSaving(false);
    }
  };

  // ========== 小组件 ==========
  const AiButton = ({ field }: { field: 'short_name' | 'papercore' | 'tags' }) => (
    <TouchableOpacity
      onPress={() => aiFill(field)}
      disabled={!!aiLoading}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 12,
        backgroundColor: C.chipBg,
      }}
    >
      {aiLoading === field ? (
        <ActivityIndicator size="small" color={C.primary} />
      ) : (
        <Feather name="zap" size={12} color={C.primary} />
      )}
      <Text style={{ fontSize: 12, fontWeight: '600', color: C.primary }}>AI 生成</Text>
    </TouchableOpacity>
  );

  const FieldLabel = ({
    text,
    field,
  }: {
    text: string;
    field?: 'short_name' | 'papercore' | 'tags';
  }) => (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
        marginTop: 20,
      }}
    >
      <Text style={{ fontSize: 14, fontWeight: '700', color: C.text }}>{text}</Text>
      {field ? <AiButton field={field} /> : null}
    </View>
  );

  if (loading) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={C.primary} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen safeAreaEdges={['left', 'right', 'bottom']}>
      <View style={{ flex: 1, backgroundColor: pageBg }}>
        {/* ======== 顶部导航 ======== */}
        <View
          style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 16,
            paddingBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottomWidth: 1,
            borderBottomColor: C.border,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }}>
              <Feather name="arrow-left" size={22} color={C.text} />
            </TouchableOpacity>
            <Text style={{ fontSize: 17, fontWeight: '700', color: C.text }}>
              {isEdit ? '编辑知识节点' : '新建知识节点'}
            </Text>
          </View>
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
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 40 }}
        >
          {/* ======== 草稿来源 Banner ======== */}
          {draftName ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                backgroundColor: C.chipBg,
                borderRadius: 10,
                padding: 12,
                marginTop: 16,
              }}
            >
              <Feather name="file-text" size={16} color={C.primary} />
              <Text style={{ flex: 1, fontSize: 13, color: C.text }} numberOfLines={1}>
                来自草稿：{draftName}
              </Text>
              <Text style={{ fontSize: 11, color: C.textSecondary }}>保存后自动关联</Text>
            </View>
          ) : null}

          {/* ======== 短名称 ======== */}
          <FieldLabel text="图谱显示名称" field="short_name" />
          <TextInput
            style={{
              backgroundColor: '#FFF',
              borderRadius: 12,
              borderWidth: 1,
              borderColor: C.border,
              paddingHorizontal: 14,
              paddingVertical: 10,
              fontSize: 15,
              color: C.text,
            }}
            placeholder="2-8 个字，如「留数定理」"
            placeholderTextColor={C.placeholder}
            value={shortName}
            onChangeText={setShortName}
            maxLength={12}
          />

          {/* ======== Papercore ======== */}
          <FieldLabel text="Papercore（知识核概）" field="papercore" />
          <TextInput
            style={{
              backgroundColor: '#FFF',
              borderRadius: 12,
              borderWidth: 1,
              borderColor: C.border,
              paddingHorizontal: 14,
              paddingVertical: 10,
              fontSize: 15,
              lineHeight: 22,
              color: C.text,
              minHeight: 100,
              textAlignVertical: 'top',
              ...noWebResize,
            }}
            placeholder="用第一人称写 30-80 字的理解总结，如「我理解留数定理是…」"
            placeholderTextColor={C.placeholder}
            value={papercore}
            onChangeText={setPapercore}
            multiline
          />

          {/* ======== 标签 ======== */}
          <FieldLabel text="标签" field="tags" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
            {tags.map((t) => (
              <TouchableOpacity
                key={t}
                onPress={() => removeTag(t)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  backgroundColor: C.chipBg,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: '600', color: C.primary }}>#{t}</Text>
                <Feather name="x" size={12} color={C.primary} />
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              style={{
                flex: 1,
                backgroundColor: '#FFF',
                borderRadius: 12,
                borderWidth: 1,
                borderColor: C.border,
                paddingHorizontal: 14,
                paddingVertical: 10,
                fontSize: 14,
                color: C.text,
              }}
              placeholder="输入标签，回车或点添加"
              placeholderTextColor={C.placeholder}
              value={tagInput}
              onChangeText={setTagInput}
              onSubmitEditing={addTag}
              returnKeyType="done"
            />
            <TouchableOpacity
              onPress={addTag}
              style={{
                justifyContent: 'center',
                paddingHorizontal: 16,
                borderRadius: 12,
                backgroundColor: C.fileBg,
                borderWidth: 1,
                borderColor: C.border,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }}>添加</Text>
            </TouchableOpacity>
          </View>

          {/* ======== 关联节点 ======== */}
          <FieldLabel text="关联节点" />
          <TouchableOpacity
            onPress={handleGetRelations}
            disabled={loadingRelations}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              paddingVertical: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: C.primary,
              borderStyle: 'dashed',
            }}
          >
            {loadingRelations ? (
              <ActivityIndicator size="small" color={C.primary} />
            ) : (
              <Feather name="link" size={14} color={C.primary} />
            )}
            <Text style={{ fontSize: 14, fontWeight: '600', color: C.primary }}>
              {suggestions.length > 0 ? '重新推荐关联' : 'AI 推荐关联节点'}
            </Text>
          </TouchableOpacity>

          {suggestions.map((s) => {
            const confirmed = confirmedRelations.has(s.nodeId);
            const ignored = ignoredRelations.has(s.nodeId);
            return (
              <View
                key={s.nodeId}
                style={{
                  marginTop: 10,
                  backgroundColor: '#FFF',
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: confirmed ? C.primary : C.border,
                  padding: 12,
                  opacity: ignored ? 0.45 : 1,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View
                    style={{
                      backgroundColor: C.chipBg,
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                      borderRadius: 6,
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: '600', color: C.primary }}>
                      {RELATION_LABELS[s.relation_type] || s.relation_type}
                    </Text>
                  </View>
                  <Text
                    style={{ flex: 1, fontSize: 14, fontWeight: '600', color: C.text }}
                    numberOfLines={1}
                  >
                    {s.short_name || `节点${s.nodeId}`}
                  </Text>
                </View>
                {s.papercore ? (
                  <Text
                    style={{ fontSize: 12, color: C.textSecondary, marginTop: 6, lineHeight: 18 }}
                    numberOfLines={2}
                  >
                    {s.papercore}
                  </Text>
                ) : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <TouchableOpacity
                    onPress={() => toggleConfirm(s.nodeId)}
                    style={{
                      flex: 1,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                      paddingVertical: 7,
                      borderRadius: 8,
                      backgroundColor: confirmed ? C.primary : C.fileBg,
                    }}
                  >
                    <Feather
                      name={confirmed ? 'check' : 'plus'}
                      size={13}
                      color={confirmed ? '#FFF' : C.textSecondary}
                    />
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '600',
                        color: confirmed ? '#FFF' : C.textSecondary,
                      }}
                    >
                      {confirmed ? '已关联' : '确认关联'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => toggleIgnore(s.nodeId)}
                    style={{
                      paddingHorizontal: 14,
                      justifyContent: 'center',
                      paddingVertical: 7,
                      borderRadius: 8,
                      backgroundColor: C.fileBg,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: '600', color: C.textSecondary }}>
                      {ignored ? '已忽略' : '忽略'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Screen>
  );
}
