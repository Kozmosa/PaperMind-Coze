/**
 * Knowledge Builder Screen — 交互式知识节点构建器
 *
 * 工作流：
 * 1. 上传图片（公式截图/手写笔记）
 * 2. AI 分析 → 流式返回 Papercore + Tags
 * 3. 用户编辑 Papercore / Short Name / Tags
 * 4. 获取关系建议 → 确认/忽略
 * 5. 图谱预览
 * 6. 保存知识节点
 */

import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  Image,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useState, useRef, useCallback } from 'react';
import { Feather } from '@expo/vector-icons';
import { Screen } from '@/components/layout/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import MiniGraphPreview from '@/components/knowledge/MiniGraphPreview';
import type { RelatedNode } from '@/components/knowledge/MiniGraphPreview';

// —— Colors ——
const CC = {
  bg: '#FFFFFF',
  primary: '#5B5FEF',
  primaryLight: '#EEF0FF',
  text: '#1E1E2E',
  textSecondary: '#6B7280',
  textTertiary: '#A0A5B5',
  border: '#E8EAF0',
  card: '#F7F8FC',
  accent: '#4ECDC4',
  warning: '#FFD93D',
  danger: '#FF6B6B',
  success: '#00B894',
};

// —— Steps ——
type Step = 'upload' | 'analyzing' | 'edit' | 'relations' | 'saving';

// —— Relation suggestion from API ——
interface RelationSuggestion {
  nodeId: number;
  short_name: string;
  papercore: string;
  tags: string[];
  relation_type: string;
  score: number;
}

export default function KnowledgeBuilderScreen() {
  const router = useSafeRouter();

  // —— State ——
  const [step, setStep] = useState<Step>('upload');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<string>('image/jpeg');

  // AI-generated content
  const [papercore, setPapercore] = useState('');
  const [shortName, setShortName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');

  // Relation suggestions
  const [suggestions, setSuggestions] = useState<RelationSuggestion[]>([]);
  const [confirmedRelations, setConfirmedRelations] = useState<Set<number>>(new Set());
  const [ignoredRelations, setIgnoredRelations] = useState<Set<number>>(new Set());
  const [loadingRelations, setLoadingRelations] = useState(false);

  // Streaming ref
  const streamBufferRef = useRef('');

  // —— 1. Select Image ——
  const handleSelectImage = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('权限不足', '请允许访问相册');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });
      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        setImageUri(asset.uri);

        // Encode to base64
        try {
          const base64 = await FileSystem.readAsStringAsync(asset.uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          setImageBase64(base64);
          const ext = (asset.fileName || asset.uri).split('.').pop()?.toLowerCase() || 'jpeg';
          const mimeMap: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
            gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
          };
          setMediaType(mimeMap[ext] || 'image/jpeg');
        } catch (e) {
          console.warn('Base64 encode failed:', e);
          Alert.alert('错误', '图片编码失败，请重试');
          return;
        }
      }
    } catch (e) {
      console.error('Image picker error:', e);
    }
  };

  // —— 2. AI Analysis (SSE stream) ——
  const handleAnalyze = () => {
    if (!imageBase64) {
      Alert.alert('提示', '请先选择一张图片');
      return;
    }

    setStep('analyzing');
    streamBufferRef.current = '';

    const xhr = new XMLHttpRequest();
    const url = `${process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 'http://localhost:9091'}/api/v1/ai/knowledge-builder`;

    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/json');

    let done = false;
    xhr.onprogress = () => {
      if (done) return;
      const text = xhr.responseText;
      const lines = text.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            done = true;
            parseStreamResult(streamBufferRef.current);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.content) {
              streamBufferRef.current += parsed.content;
            }
            if (parsed.error) {
              done = true;
              Alert.alert('分析失败', parsed.error);
              setStep('upload');
              return;
            }
          } catch {}
        }
      }
    };

    xhr.onload = () => {
      if (!done) {
        done = true;
        parseStreamResult(streamBufferRef.current);
      }
    };

    xhr.onerror = () => {
      if (!done) {
        done = true;
        Alert.alert('网络错误', '请检查网络连接后重试');
        setStep('upload');
      }
    };

    xhr.send(JSON.stringify({
      imageBase64,
      mediaType,
      rawContent: '',
    }));
  };

  // Parse "PAPERCORE: ...\nTAGS: ..." from stream result
  const parseStreamResult = (text: string) => {
    const papercoreMatch = text.match(/PAPERCORE:\s*(.+?)(?:\n|$)/i);
    const tagsMatch = text.match(/TAGS:\s*(.+?)(?:\n|$)/i);

    if (papercoreMatch) setPapercore(papercoreMatch[1].trim());
    if (tagsMatch) {
      const rawTags = tagsMatch[1].trim();
      const parsed = rawTags
        .split(/[,，、]/)
        .map(t => t.trim().replace(/^#/, ''))
        .filter(t => t.length > 0);
      setTags(parsed);
    }

    // If neither matched, use the full text as papercore
    if (!papercoreMatch && !tagsMatch && text.trim()) {
      setPapercore(text.trim());
    }

    setStep('edit');
  };

  // —— 3. Tag editing ——
  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, '');
    if (t && !tags.includes(t)) {
      setTags([...tags, t]);
    }
    setTagInput('');
  };

  const removeTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag));
  };

  // —— 4. Get relation suggestions ——
  const handleGetRelations = async () => {
    if (!papercore.trim()) {
      Alert.alert('提示', '请先填写 Papercore');
      return;
    }

    setLoadingRelations(true);
    try {
      const res = await api.suggestRelations(papercore, tags.map(t => `#${t}`));
      const all = (res.data as any)?.suggestions || [];
      setSuggestions(all);
      setConfirmedRelations(new Set());
      setIgnoredRelations(new Set());
      setStep('relations');
    } catch (e: any) {
      console.error('Suggest relations failed:', e);
      Alert.alert('获取关系失败', e.message || '请检查网络连接');
    } finally {
      setLoadingRelations(false);
    }
  };

  const toggleConfirm = (nodeId: number) => {
    setConfirmedRelations(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      // Remove from ignored if confirming
      setIgnoredRelations(prev2 => {
        const n2 = new Set(prev2);
        n2.delete(nodeId);
        return n2;
      });
      return next;
    });
  };

  const toggleIgnore = (nodeId: number) => {
    setIgnoredRelations(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      // Remove from confirmed if ignoring
      setConfirmedRelations(prev2 => {
        const n2 = new Set(prev2);
        n2.delete(nodeId);
        return n2;
      });
      return next;
    });
  };

  const regenerateRelations = () => {
    setSuggestions([]);
    setConfirmedRelations(new Set());
    setIgnoredRelations(new Set());
    handleGetRelations();
  };

  // —— 5. Get confirmed relation nodes for preview ——
  const confirmedNodes: RelatedNode[] = suggestions
    .filter(s => confirmedRelations.has(s.nodeId))
    .map(s => ({
      id: s.nodeId,
      short_name: s.short_name || `节点${s.nodeId}`,
      relation_type: s.relation_type as RelatedNode['relation_type'],
      score: s.score,
    }));

  // —— 6. Save ——
  const handleSave = async () => {
    if (!papercore.trim()) {
      Alert.alert('提示', 'Papercore 不能为空');
      return;
    }

    setStep('saving');
    try {
      // Build relations object
      const relations: Record<string, number[]> = {};
      suggestions
        .filter(s => confirmedRelations.has(s.nodeId))
        .forEach(s => {
          const type = s.relation_type;
          if (!relations[type]) relations[type] = [];
          relations[type].push(s.nodeId);
        });

      await api.createKnowledgeNode({
        papercore: papercore.trim(),
        short_name: shortName.trim() || papercore.trim().substring(0, 8),
        tags: tags.map(t => `#${t}`),
        relations,
      });

      Alert.alert('保存成功', '知识节点已创建', [
        { text: '返回', onPress: () => router.back() },
        { text: '查看知识图谱', onPress: () => router.replace('/knowledge') },
      ]);
    } catch (e: any) {
      console.error('Save failed:', e);
      Alert.alert('保存失败', e.message || '请重试');
      setStep('relations');
    }
  };

  // —— Relation type display ——
  const relationTypeLabel = (type: string): string => {
    switch (type) {
      case 'prerequisite': return '前置知识';
      case 'related': return '相关知识';
      case 'parent': return '上层概念';
      default: return type;
    }
  };

  const relationTypeColor = (type: string): string => {
    switch (type) {
      case 'prerequisite': return '#FF6B6B';
      case 'related': return '#4ECDC4';
      case 'parent': return '#FFD93D';
      default: return '#6B7280';
    }
  };

  // —— Render ——
  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <Feather name="arrow-left" size={22} color={CC.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>构建知识节点</Text>
          <View style={styles.headerBtn} />
        </View>

        {/* Step indicator */}
        <View style={styles.steps}>
          {(['upload', 'edit', 'relations'] as Step[]).map((s, i) => {
            const active = step === s || (s === 'edit' && (step === 'analyzing' || step === 'saving')) ||
                           (s === 'relations' && step === 'saving');
            const done = (i === 0 && (step !== 'upload')) ||
                         (i === 1 && (step === 'relations' || step === 'saving')) ||
                         (i === 2 && step === 'saving');
            return (
              <View key={s} style={styles.stepRow}>
                <View style={[
                  styles.stepDot,
                  done && styles.stepDotDone,
                  active && !done && styles.stepDotActive,
                ]}>
                  {done ? (
                    <Feather name="check" size={12} color="#FFF" />
                  ) : (
                    <Text style={[styles.stepNum, active && styles.stepNumActive]}>{i + 1}</Text>
                  )}
                </View>
                <Text style={[styles.stepLabel, active && styles.stepLabelActive]}>
                  {{ upload: '上传', edit: '编辑', relations: '关系' }[s]}
                </Text>
                {i < 2 && <View style={styles.stepLine} />}
              </View>
            );
          })}
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/*—— Step: Upload ——*/}
          {step === 'upload' && (
            <View style={styles.uploadSection}>
              <TouchableOpacity style={styles.uploadBox} onPress={handleSelectImage}>
                {imageUri ? (
                  <Image source={{ uri: imageUri }} style={styles.uploadImage} resizeMode="contain" />
                ) : (
                  <View style={styles.uploadPlaceholder}>
                    <Feather name="image" size={48} color={CC.textTertiary} />
                    <Text style={styles.uploadText}>点击选择图片</Text>
                    <Text style={styles.uploadHint}>公式截图、手写笔记、教材页面</Text>
                  </View>
                )}
              </TouchableOpacity>

              {imageUri && (
                <TouchableOpacity style={styles.analyzeBtn} onPress={handleAnalyze}>
                  <Feather name="zap" size={18} color="#FFF" />
                  <Text style={styles.analyzeBtnText}>AI 分析图片</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity style={styles.retakeBtn} onPress={handleSelectImage}>
                <Text style={styles.retakeText}>
                  {imageUri ? '重新选择' : '从相册选择'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/*—— Step: Analyzing ——*/}
          {step === 'analyzing' && (
            <View style={styles.analyzingSection}>
              {imageUri && (
                <Image source={{ uri: imageUri }} style={styles.previewImage} resizeMode="contain" />
              )}
              <ActivityIndicator size="large" color={CC.primary} style={{ marginTop: 20 }} />
              <Text style={styles.analyzingText}>AI 正在分析图片内容...</Text>
              <Text style={styles.analyzingHint}>识别公式、提取概念、生成 Papercore</Text>
            </View>
          )}

          {/*—— Step: Edit ——*/}
          {(step === 'edit' || step === 'relations' || step === 'saving') && (
            <View style={styles.editSection}>
              {/* Preview image */}
              {imageUri && (
                <Image source={{ uri: imageUri }} style={styles.previewImageSmall} resizeMode="contain" />
              )}

              {/* Papercore */}
              <Text style={styles.fieldLabel}>Papercore（知识核概）</Text>
              <TextInput
                style={styles.papercoreInput}
                value={papercore}
                onChangeText={setPapercore}
                placeholder="输入你对这个知识点的个人理解..."
                placeholderTextColor={CC.textTertiary}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />

              {/* Short Name */}
              <Text style={styles.fieldLabel}>Short Name（图谱显示名）</Text>
              <TextInput
                style={styles.shortNameInput}
                value={shortName}
                onChangeText={setShortName}
                placeholder="2-8字，如：条件概率"
                placeholderTextColor={CC.textTertiary}
                maxLength={8}
              />

              {/* Tags */}
              <Text style={styles.fieldLabel}>Tags</Text>
              <View style={styles.tagsContainer}>
                {tags.map((tag) => (
                  <TouchableOpacity
                    key={tag}
                    style={styles.tagChip}
                    onPress={() => removeTag(tag)}
                  >
                    <Text style={styles.tagText}>#{tag}</Text>
                    <Feather name="x" size={12} color={CC.primary} />
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.tagInputRow}>
                <TextInput
                  style={styles.tagInput}
                  value={tagInput}
                  onChangeText={setTagInput}
                  placeholder="输入标签，如：核心概念"
                  placeholderTextColor={CC.textTertiary}
                  onSubmitEditing={addTag}
                  returnKeyType="done"
                />
                <TouchableOpacity style={styles.addTagBtn} onPress={addTag}>
                  <Feather name="plus" size={16} color="#FFF" />
                </TouchableOpacity>
              </View>

              {/* Actions */}
              {step === 'edit' && (
                <View style={styles.actionRow}>
                  <TouchableOpacity style={styles.regenerateBtn} onPress={handleAnalyze}>
                    <Feather name="refresh-cw" size={14} color={CC.primary} />
                    <Text style={styles.regenerateBtnText}>重新生成</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.nextBtn, loadingRelations && styles.btnDisabled]}
                    onPress={handleGetRelations}
                    disabled={loadingRelations}
                  >
                    {loadingRelations ? (
                      <ActivityIndicator size="small" color="#FFF" />
                    ) : (
                      <>
                        <Feather name="git-branch" size={16} color="#FFF" />
                        <Text style={styles.nextBtnText}>获取关系建议</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}

          {/*—— Step: Relations ——*/}
          {(step === 'relations' || step === 'saving') && suggestions.length > 0 && (
            <View style={styles.relationsSection}>
              <Text style={styles.sectionTitle}>关系建议</Text>
              <Text style={styles.sectionHint}>确认或忽略 AI 建议的知识节点关系</Text>

              {suggestions.map((s) => {
                const confirmed = confirmedRelations.has(s.nodeId);
                const ignored = ignoredRelations.has(s.nodeId);
                if (ignored) return null;

                return (
                  <View
                    key={s.nodeId}
                    style={[styles.relationCard, confirmed && styles.relationCardConfirmed]}
                  >
                    <View style={styles.relationInfo}>
                      <View style={styles.relationHeader}>
                        <View style={[styles.relationBadge, { backgroundColor: relationTypeColor(s.relation_type) + '20' }]}>
                          <Text style={[styles.relationBadgeText, { color: relationTypeColor(s.relation_type) }]}>
                            {relationTypeLabel(s.relation_type)}
                          </Text>
                        </View>
                        <Text style={styles.relationScore}>{Math.round(s.score * 100)}% 匹配</Text>
                      </View>
                      <Text style={styles.relationName}>{s.short_name || `节点 ${s.nodeId}`}</Text>
                      <Text style={styles.relationPapercore} numberOfLines={2}>
                        {s.papercore}
                      </Text>
                      {s.tags && s.tags.length > 0 && (
                        <Text style={styles.relationTags}>{s.tags.map(t => `#${t}`).join(' ')}</Text>
                      )}
                    </View>
                    <View style={styles.relationActions}>
                      {!confirmed ? (
                        <TouchableOpacity
                          style={styles.confirmBtn}
                          onPress={() => toggleConfirm(s.nodeId)}
                        >
                          <Feather name="check" size={16} color="#FFF" />
                          <Text style={styles.confirmBtnText}>确认</Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          style={styles.confirmedBtn}
                          onPress={() => toggleConfirm(s.nodeId)}
                        >
                          <Feather name="check" size={16} color={CC.success} />
                          <Text style={styles.confirmedBtnText}>已确认</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity
                        style={styles.ignoreBtn}
                        onPress={() => toggleIgnore(s.nodeId)}
                      >
                        <Feather name="x" size={14} color={CC.textTertiary} />
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })}

              {/* Mini Graph Preview */}
              {confirmedNodes.length > 0 && (
                <MiniGraphPreview
                  centerLabel={shortName || papercore.substring(0, 8)}
                  centerTags={tags}
                  relatedNodes={confirmedNodes}
                  width={350}
                  height={250}
                />
              )}

              {/* Actions */}
              <View style={styles.relationsBottomActions}>
                <TouchableOpacity style={styles.regenerateBtn} onPress={regenerateRelations}>
                  <Feather name="refresh-cw" size={14} color={CC.primary} />
                  <Text style={styles.regenerateBtnText}>重新生成</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.saveBtn, step === 'saving' && styles.btnDisabled]}
                  onPress={handleSave}
                  disabled={step === 'saving'}
                >
                  {step === 'saving' ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <>
                      <Feather name="save" size={16} color="#FFF" />
                      <Text style={styles.saveBtnText}>保存知识节点</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

// —— Styles ——
const styles = StyleSheet.create({
  flex: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: CC.bg,
    borderBottomWidth: 1,
    borderBottomColor: CC.border,
  },
  headerBtn: { width: 36, height: 36, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: CC.text },

  // Steps
  steps: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: CC.card,
    borderBottomWidth: 1,
    borderBottomColor: CC.border,
  },
  stepRow: { flexDirection: 'row', alignItems: 'center' },
  stepDot: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: CC.border, justifyContent: 'center', alignItems: 'center',
  },
  stepDotDone: { backgroundColor: CC.success },
  stepDotActive: { backgroundColor: CC.primary },
  stepNum: { fontSize: 11, color: CC.textTertiary, fontWeight: '600' },
  stepNumActive: { color: '#FFF' },
  stepLabel: { marginLeft: 6, fontSize: 12, color: CC.textTertiary, marginRight: 4 },
  stepLabelActive: { color: CC.primary, fontWeight: '600' },
  stepLine: { width: 32, height: 2, backgroundColor: CC.border, marginHorizontal: 8 },

  // Content
  content: { padding: 16, paddingBottom: 40 },

  // Upload
  uploadSection: { alignItems: 'center' },
  uploadBox: {
    width: '100%', height: 220, borderRadius: 16, borderWidth: 2,
    borderColor: CC.border, borderStyle: 'dashed', overflow: 'hidden',
    backgroundColor: CC.card,
  },
  uploadImage: { width: '100%', height: '100%' },
  uploadPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  uploadText: { fontSize: 16, fontWeight: '600', color: CC.textSecondary, marginTop: 12 },
  uploadHint: { fontSize: 13, color: CC.textTertiary, marginTop: 4 },
  analyzeBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 16, paddingHorizontal: 32, paddingVertical: 14,
    backgroundColor: CC.primary, borderRadius: 12, gap: 8,
  },
  analyzeBtnText: { color: '#FFF', fontSize: 16, fontWeight: '700' },
  retakeBtn: { marginTop: 12, padding: 8 },
  retakeText: { color: CC.primary, fontSize: 14, fontWeight: '600' },

  // Analyzing
  analyzingSection: { alignItems: 'center', paddingTop: 20 },
  previewImage: { width: '100%', height: 180, borderRadius: 12, backgroundColor: CC.card },
  analyzingText: { fontSize: 16, fontWeight: '600', color: CC.text, marginTop: 16 },
  analyzingHint: { fontSize: 13, color: CC.textTertiary, marginTop: 4 },

  // Edit
  editSection: {},
  previewImageSmall: { width: '100%', height: 120, borderRadius: 12, marginBottom: 16, backgroundColor: CC.card },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: CC.textSecondary, marginBottom: 8, marginTop: 16 },
  papercoreInput: {
    backgroundColor: CC.card, borderRadius: 12, padding: 14,
    fontSize: 15, color: CC.text, minHeight: 100,
    borderWidth: 1, borderColor: CC.border,
  },
  shortNameInput: {
    backgroundColor: CC.card, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, color: CC.text, borderWidth: 1, borderColor: CC.border,
  },
  tagsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  tagChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: CC.primaryLight, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6,
  },
  tagText: { fontSize: 13, color: CC.primary, fontWeight: '600' },
  tagInputRow: { flexDirection: 'row', gap: 8 },
  tagInput: {
    flex: 1, backgroundColor: CC.card, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 14, color: CC.text, borderWidth: 1, borderColor: CC.border,
  },
  addTagBtn: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: CC.primary, justifyContent: 'center', alignItems: 'center',
  },

  // Action row
  actionRow: { flexDirection: 'row', gap: 12, marginTop: 24 },
  regenerateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 12, backgroundColor: CC.primaryLight,
  },
  regenerateBtnText: { color: CC.primary, fontSize: 14, fontWeight: '600' },
  nextBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: 12, backgroundColor: CC.primary,
  },
  nextBtnText: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  btnDisabled: { opacity: 0.6 },

  // Relations
  relationsSection: { marginTop: 4 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: CC.text, marginBottom: 4 },
  sectionHint: { fontSize: 13, color: CC.textTertiary, marginBottom: 16 },

  relationCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: CC.card, borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: CC.border, marginBottom: 10,
  },
  relationCardConfirmed: { borderColor: CC.success, backgroundColor: '#F0FFF8' },
  relationInfo: { flex: 1 },
  relationHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  relationBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  relationBadgeText: { fontSize: 11, fontWeight: '700' },
  relationScore: { fontSize: 11, color: CC.textTertiary },
  relationName: { fontSize: 15, fontWeight: '700', color: CC.text, marginBottom: 4 },
  relationPapercore: { fontSize: 13, color: CC.textSecondary, lineHeight: 18, marginBottom: 4 },
  relationTags: { fontSize: 11, color: CC.primary },
  relationActions: { flexDirection: 'column', alignItems: 'center', gap: 6, marginLeft: 10 },
  confirmBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: CC.primary, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8,
  },
  confirmBtnText: { color: '#FFF', fontSize: 13, fontWeight: '600' },
  confirmedBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#F0FFF8', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8,
    borderWidth: 1, borderColor: CC.success,
  },
  confirmedBtnText: { color: CC.success, fontSize: 13, fontWeight: '600' },
  ignoreBtn: { padding: 8 },
  relationsBottomActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  saveBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: 12, backgroundColor: CC.success,
  },
  saveBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
});
