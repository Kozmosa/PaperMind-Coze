import { View, Text, ScrollView, TouchableOpacity, TextInput, Modal, Alert } from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';
import { useAuth } from '@/contexts/AuthContext';

const COLORS = {
  bg: '#F0F0F3',
  card: '#F0F0F3',
  text: '#2D3436',
  textSecondary: '#636E72',
  textMuted: '#B2BEC3',
  primary: '#6C63FF',
  green: '#00B894',
  orange: '#FF9F43',
  red: '#FF3B30',
  white: '#FFFFFF',
};

type RecentRecord = {
  id: string;
  title?: string;
  content?: string;
  description?: string;
  file_name?: string;
  file_url?: string;
  tags?: string[];
  papercore?: string;
  logical_path?: string;
  ai_processed?: boolean;
  viewed_after_process?: boolean;
  record_type: 'study_note' | 'material';
  created_at: string;
};

export default function ControlCenterScreen() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const { refreshKey } = useAuth();

  const [recentRecords, setRecentRecords] = useState<RecentRecord[]>([]);
  const [allRecords, setAllRecords] = useState<RecentRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // Stats
  const [stats, setStats] = useState({ notes: 0, materials: 0, unviewed: 0 });

  // Study note modal
  const [noteModalVisible, setNoteModalVisible] = useState(false);
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [noteFileUri, setNoteFileUri] = useState<string | null>(null);
  const [noteFileName, setNoteFileName] = useState<string | null>(null);
  const [noteSubmitting, setNoteSubmitting] = useState(false);

  // Material modal
  const [materialModalVisible, setMaterialModalVisible] = useState(false);
  const [materialFileUri, setMaterialFileUri] = useState<string | null>(null);
  const [materialFileName, setMaterialFileName] = useState<string | null>(null);
  const [materialSubmitting, setMaterialSubmitting] = useState(false);

  // All records modal
  const [allRecordsModal, setAllRecordsModal] = useState(false);

  // Detail modal (quick view)
  const [detailRecord, setDetailRecord] = useState<RecentRecord | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await api.getRecentRecords();
      const records: RecentRecord[] = res.data || [];
      setAllRecords(records);
      setRecentRecords(records.slice(0, 10));

      const notes = records.filter(r => r.record_type === 'study_note');
      const materials = records.filter(r => r.record_type === 'material');
      const unviewed = records.filter(r => r.ai_processed && !r.viewed_after_process);

      setStats({
        notes: notes.length,
        materials: materials.length,
        unviewed: unviewed.length,
      });
    } catch (e) {
      console.error('Failed to load records', e);
      // Fallback: load separately
      try {
        const [noteRes, matRes] = await Promise.all([
          api.getStudyNotes(),
          api.getMaterials(),
        ]);
        const notes = (noteRes.data || []).map((n: any) => ({ ...n, record_type: 'study_note' as const }));
        const mats = (matRes.data || []).map((m: any) => ({ ...m, record_type: 'material' as const }));
        const combined = [...notes, ...mats].sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        setAllRecords(combined);
        setRecentRecords(combined.slice(0, 10));
        const unviewed = combined.filter((r: any) => r.ai_processed && !r.viewed_after_process);
        setStats({
          notes: notes.length,
          materials: mats.length,
          unviewed: unviewed.length,
        });
      } catch (e2) {
        console.error('Fallback load failed', e2);
      }
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [refreshKey])
  );

  const handleRecordPress = async (record: RecentRecord) => {
    // Mark as viewed if needed
    if (record.ai_processed && !record.viewed_after_process) {
      try {
        await api.markViewed(record.record_type, record.id);
      } catch {}
    }

    // Navigate to detail page (read-only mode)
    if (record.record_type === 'study_note') {
      router.push('/study-note-edit', { id: record.id });
    } else {
      router.push('/material-edit', { id: record.id });
    }
  };

  const handleSelectNoteFile = async () => {
    try {
      const result = await selectFile();
      if (result) {
        setNoteFileUri(result.uri);
        setNoteFileName(result.name);
      }
    } catch (e: any) {
      console.error('[control-center] selectNoteFile error:', e);
      Alert.alert('错误', '文件选择失败: ' + (e?.message || '未知错误'));
    }
  };

  const handleSubmitNote = async () => {
    if (!noteTitle.trim() && !noteContent.trim() && !noteFileUri) {
      Alert.alert('提示', '请填写学习纪要内容或上传文件');
      return;
    }
    setNoteSubmitting(true);
    try {
      let fileUrl = null;
      let fileName = noteFileName;

      if (noteFileUri) {
        const uploadRes = await api.uploadFile(noteFileUri, noteFileName || 'file', 'application/octet-stream');
        fileUrl = uploadRes.fileUrl;
        fileName = uploadRes.fileName || noteFileName;
      }

      const createRes = await api.createStudyNote({
        title: noteTitle || '学习纪要',
        content: noteContent,
        file_url: fileUrl,
        file_name: fileName,
      });

      // Close modal immediately — note is saved
      setNoteModalVisible(false);
      resetNoteForm();
      loadData();
      Alert.alert('保存成功', '学习纪要已保存，AI 将在后台自动编排，完成后小红点提示');

      // Trigger AI processing in background (don't block UI)
      const newId = createRes?.data?.id;
      if (newId) {
        const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 'http://localhost:9091';
        fetch(`${BASE_URL}/api/v1/knowledge-builder/process-content`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'study_note', id: newId }),
        }).then(async () => {
          // After AI finishes, reload data so red dot appears
          loadData();
        }).catch(() => {});
      }
    } catch (e: any) {
      Alert.alert('错误', e.message || '保存失败');
    } finally {
      setNoteSubmitting(false);
    }
  };

  const resetNoteForm = () => {
    setNoteTitle('');
    setNoteContent('');
    setNoteFileUri(null);
    setNoteFileName(null);
  };

  const handleSelectMaterialFile = async () => {
    try {
      console.log('[control-center] Opening file picker...');
      const result = await selectFile();
      console.log('[control-center] File picker result:', result ? `selected: ${result.name}` : 'cancelled/empty');
      if (result) {
        setMaterialFileUri(result.uri);
        setMaterialFileName(result.name);
      }
    } catch (e: any) {
      console.error('[control-center] selectFile error:', e);
      Alert.alert('错误', '文件选择失败: ' + (e?.message || '未知错误'));
    }
  };

  const handleSubmitMaterial = async () => {
    if (!materialFileUri) {
      Alert.alert('提示', '请先选择要上传的文件');
      return;
    }
    setMaterialSubmitting(true);
    try {
      const uploadRes = await api.uploadFile(
        materialFileUri,
        materialFileName || 'file',
        'application/octet-stream'
      );

      const createRes = await api.createMaterial({
        title: materialFileName || '上传资料',
        file_url: uploadRes.fileUrl,
        file_name: uploadRes.fileName || materialFileName,
        mime_type: uploadRes.mimeType,
        file_size: uploadRes.fileSize,
      });

      // Close modal immediately — file is captured
      setMaterialModalVisible(false);
      setMaterialFileUri(null);
      setMaterialFileName(null);
      loadData();
      Alert.alert('上传成功', '文件已上传，AI 将在后台自动编排，完成后小红点提示');

      // Trigger AI processing in background (don't block UI)
      const newId = createRes?.data?.id;
      if (newId) {
        const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 'http://localhost:9091';
        fetch(`${BASE_URL}/api/v1/knowledge-builder/process-content`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'material', id: newId }),
        }).then(async () => {
          // After AI finishes, reload data so red dot appears
          loadData();
        }).catch(() => {});
      }
    } catch (e: any) {
      Alert.alert('错误', e.message || '上传失败');
    } finally {
      setMaterialSubmitting(false);
    }
  };

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
      <View style={{ flex: 1, backgroundColor: COLORS.bg }}>
        {/* Header */}
        <View style={{ paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 8 }}>
          <Text style={{ fontSize: 28, fontWeight: '800', color: COLORS.text }}>
            控制中心
          </Text>
          <Text style={{ fontSize: 14, color: COLORS.textSecondary, marginTop: 4 }}>
            学习数据总览与快捷操作
          </Text>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Stats Row */}
          <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
            {[
              { label: '学习纪要', value: stats.notes, icon: 'edit-3', color: COLORS.green },
              { label: '上传资料', value: stats.materials, icon: 'upload', color: COLORS.orange },
              { label: '待查看', value: stats.unviewed, icon: 'bell', color: COLORS.red },
            ].map((item, i) => (
              <View key={i} style={{
                flex: 1,
                backgroundColor: COLORS.card,
                borderRadius: 20,
                padding: 16,
                shadowColor: '#D1D9E6',
                shadowOffset: { width: 4, height: 4 },
                shadowOpacity: 0.6,
                shadowRadius: 6,
                elevation: 4,
              }}>
                <View style={{
                  width: 36, height: 36, borderRadius: 18,
                  backgroundColor: `${item.color}1A`,
                  justifyContent: 'center', alignItems: 'center',
                  marginBottom: 10,
                }}>
                  <Feather name={item.icon as any} size={16} color={item.color} />
                </View>
                <Text style={{ fontSize: 24, fontWeight: '800', color: COLORS.text }}>
                  {item.value}
                </Text>
                <Text style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 4 }}>
                  {item.label}
                </Text>
              </View>
            ))}
          </View>

          {/* Quick Actions */}
          <View style={{
            backgroundColor: COLORS.card,
            borderRadius: 24,
            padding: 20,
            marginBottom: 24,
            shadowColor: '#D1D9E6',
            shadowOffset: { width: 4, height: 4 },
            shadowOpacity: 0.6,
            shadowRadius: 6,
            elevation: 4,
          }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: COLORS.text, marginBottom: 16 }}>
              快捷操作
            </Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity
                style={{ flex: 1, alignItems: 'center', padding: 16, backgroundColor: '#E8E8EB', borderRadius: 16 }}
                onPress={() => router.push('/study-note-edit')}
              >
                <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,184,148,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: 10 }}>
                  <Feather name="edit-3" size={24} color={COLORS.green} />
                </View>
                <Text style={{ fontSize: 13, fontWeight: '700', color: COLORS.text }}>写入学习纪要</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={{ flex: 1, alignItems: 'center', padding: 16, backgroundColor: '#E8E8EB', borderRadius: 16 }}
                onPress={() => setMaterialModalVisible(true)}
              >
                <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,159,67,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: 10 }}>
                  <Feather name="upload" size={24} color={COLORS.orange} />
                </View>
                <Text style={{ fontSize: 13, fontWeight: '700', color: COLORS.text }}>上传资料</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Recent Records */}
          <View style={{
            backgroundColor: COLORS.card,
            borderRadius: 24,
            padding: 20,
            marginBottom: 24,
            shadowColor: '#D1D9E6',
            shadowOffset: { width: 4, height: 4 },
            shadowOpacity: 0.6,
            shadowRadius: 6,
            elevation: 4,
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: COLORS.text }}>
                  最近学习
                </Text>
                {stats.unviewed > 0 && (
                  <View style={{ marginLeft: 8, backgroundColor: COLORS.red, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
                    <Text style={{ color: '#FFF', fontSize: 12, fontWeight: '700' }}>{stats.unviewed}</Text>
                  </View>
                )}
              </View>
              <TouchableOpacity onPress={() => setAllRecordsModal(true)}>
                <Text style={{ fontSize: 14, color: COLORS.primary, fontWeight: '600' }}>查看全部 →</Text>
              </TouchableOpacity>
            </View>

            {loading ? (
              <View style={{ alignItems: 'center', paddingVertical: 24 }}>
                <Text style={{ color: COLORS.textMuted }}>加载中...</Text>
              </View>
            ) : recentRecords.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 24 }}>
                <Feather name="inbox" size={40} color={COLORS.textMuted} />
                <Text style={{ fontSize: 14, color: COLORS.textSecondary, marginTop: 12, textAlign: 'center' }}>
                  还没有学习记录
                </Text>
                <Text style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 4 }}>
                  点击上方快捷操作开始记录
                </Text>
              </View>
            ) : (
              recentRecords.map((record) => {
                const isNote = record.record_type === 'study_note';
                const hasRedDot = record.ai_processed && !record.viewed_after_process;
                const displayTitle = record.title || (record as any).name || record.file_name || (isNote ? '学习纪要' : '上传资料');

                return (
                  <TouchableOpacity
                    key={`${record.record_type}_${record.id}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 12,
                      borderBottomWidth: 1,
                      borderBottomColor: 'rgba(0,0,0,0.04)',
                    }}
                    onPress={() => handleRecordPress(record)}
                  >
                    <View style={{
                      width: 40, height: 40, borderRadius: 20,
                      backgroundColor: isNote ? 'rgba(0,184,148,0.12)' : 'rgba(255,159,67,0.12)',
                      justifyContent: 'center', alignItems: 'center',
                    }}>
                      <Feather
                        name={isNote ? 'edit-3' : 'upload'}
                        size={18}
                        color={isNote ? COLORS.green : COLORS.orange}
                      />
                    </View>
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: COLORS.text, flex: 1 }} numberOfLines={1}>
                          {displayTitle}
                        </Text>
                        {/* Red dot for unviewed AI-processed records */}
                        {hasRedDot && (
                          <View style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            backgroundColor: COLORS.red,
                            marginLeft: 6,
                          }} />
                        )}
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                        <Text style={{ fontSize: 12, color: COLORS.textSecondary }}>
                          {isNote ? '学习纪要' : '资料'} · {formatDate(record.created_at)}
                        </Text>
                        {record.logical_path ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8 }}>
                            <Feather name="folder" size={10} color={COLORS.textMuted} />
                            <Text style={{ fontSize: 10, color: COLORS.textMuted, marginLeft: 2 }} numberOfLines={1}>
                              {record.logical_path.split('/').filter(Boolean).slice(-1)[0] || ''}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      {record.papercore ? (
                        <Text style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }} numberOfLines={1}>
                          {record.papercore}
                        </Text>
                      ) : null}
                    </View>
                    <Feather name="chevron-right" size={16} color={COLORS.textMuted} />
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        </ScrollView>
      </View>

      {/* Study Note Modal */}
      <Modal visible={noteModalVisible} animationType="slide" transparent>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: COLORS.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '90%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: COLORS.bg }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: COLORS.text }}>📝 新学习便签</Text>
              <TouchableOpacity onPress={() => { setNoteModalVisible(false); resetNoteForm(); }}>
                <Feather name="x" size={24} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ padding: 20 }} showsVerticalScrollIndicator={false}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: COLORS.text, marginBottom: 8 }}>标题</Text>
              <TextInput
                style={{ backgroundColor: COLORS.bg, borderRadius: 16, padding: 14, fontSize: 15, color: COLORS.text, marginBottom: 16 }}
                placeholder="输入便签标题..."
                placeholderTextColor={COLORS.textMuted}
                value={noteTitle}
                onChangeText={setNoteTitle}
              />

              <Text style={{ fontSize: 14, fontWeight: '600', color: COLORS.text, marginBottom: 8 }}>内容</Text>
              <TextInput
                style={{ backgroundColor: COLORS.bg, borderRadius: 16, padding: 14, fontSize: 15, color: COLORS.text, marginBottom: 16, minHeight: 120, textAlignVertical: 'top' }}
                placeholder="今天学到了什么？写下你的理解..."
                placeholderTextColor={COLORS.textMuted}
                value={noteContent}
                onChangeText={setNoteContent}
                multiline
                textAlignVertical="top"
              />

              <Text style={{ fontSize: 14, fontWeight: '600', color: COLORS.text, marginBottom: 8 }}>附件（可选）</Text>
              <TouchableOpacity
                style={{ borderRadius: 16, borderWidth: 2, borderStyle: 'dashed', borderColor: COLORS.textMuted, padding: 20, alignItems: 'center', marginBottom: 24 }}
                onPress={handleSelectNoteFile}
              >
                {noteFileUri ? (
                  <View style={{ alignItems: 'center' }}>
                    <Feather name="file" size={32} color={COLORS.primary} />
                    <Text style={{ marginTop: 8, color: COLORS.primary, fontWeight: '600' }}>{noteFileName}</Text>
                  </View>
                ) : (
                  <View style={{ alignItems: 'center' }}>
                    <Feather name="image" size={32} color={COLORS.textMuted} />
                    <Text style={{ marginTop: 8, color: COLORS.textMuted }}>点击上传照片或文件</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={{ backgroundColor: noteSubmitting ? '#D1D5DB' : COLORS.primary, borderRadius: 16, padding: 16, alignItems: 'center', marginBottom: 24 }}
                onPress={handleSubmitNote}
                disabled={noteSubmitting}
              >
                <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 16 }}>
                  保存学习纪要
                </Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Material Modal */}
      <Modal visible={materialModalVisible} animationType="slide" transparent>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: COLORS.white, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: COLORS.bg }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: COLORS.text }}>上传资料</Text>
              <TouchableOpacity onPress={() => { setMaterialModalVisible(false); setMaterialFileUri(null); setMaterialFileName(null); }}>
                <Feather name="x" size={24} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>

            <View style={{ padding: 20 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: COLORS.text, marginBottom: 8 }}>选择文件</Text>
              <TouchableOpacity
                style={{ borderRadius: 16, borderWidth: 2, borderStyle: 'dashed', borderColor: COLORS.textMuted, padding: 32, alignItems: 'center', marginBottom: 24 }}
                onPress={handleSelectMaterialFile}
              >
                {materialFileUri ? (
                  <View style={{ alignItems: 'center' }}>
                    <Feather name="file" size={40} color={COLORS.orange} />
                    <Text style={{ marginTop: 8, color: COLORS.orange, fontWeight: '600' }}>{materialFileName}</Text>
                  </View>
                ) : (
                  <View style={{ alignItems: 'center' }}>
                    <Feather name="upload" size={40} color={COLORS.textMuted} />
                    <Text style={{ marginTop: 8, color: COLORS.textMuted }}>点击选择文件</Text>
                    <Text style={{ marginTop: 4, color: COLORS.textMuted, fontSize: 12 }}>支持图片、PDF、文档等</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={{ backgroundColor: !materialFileUri || materialSubmitting ? '#D1D5DB' : COLORS.orange, borderRadius: 16, padding: 16, alignItems: 'center', marginBottom: 24 }}
                onPress={handleSubmitMaterial}
                disabled={!materialFileUri || materialSubmitting}
              >
                <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 16 }}>
                  上传资料
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* All Records Modal */}
      <Modal visible={allRecordsModal} animationType="slide" transparent>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: COLORS.white, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '85%' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: COLORS.bg }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: COLORS.text }}>全部记录</Text>
              <TouchableOpacity onPress={() => setAllRecordsModal(false)}>
                <Feather name="x" size={24} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>

            <ScrollView style={{ padding: 20 }} showsVerticalScrollIndicator={false}>
              {allRecords.map((record) => {
                const isNote = record.record_type === 'study_note';
                const hasRedDot = record.ai_processed && !record.viewed_after_process;
                const displayTitle = record.title || (record as any).name || record.file_name || (isNote ? '学习纪要' : '上传资料');

                return (
                  <TouchableOpacity
                    key={`all_${record.record_type}_${record.id}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 14,
                      borderBottomWidth: 1,
                      borderBottomColor: COLORS.bg,
                    }}
                    onPress={() => {
                      setAllRecordsModal(false);
                      handleRecordPress(record);
                    }}
                  >
                    <View style={{
                      width: 40, height: 40, borderRadius: 20,
                      backgroundColor: isNote ? 'rgba(0,184,148,0.12)' : 'rgba(255,159,67,0.12)',
                      justifyContent: 'center', alignItems: 'center',
                    }}>
                      <Feather
                        name={isNote ? 'edit-3' : 'upload'}
                        size={18}
                        color={isNote ? COLORS.green : COLORS.orange}
                      />
                    </View>
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ fontSize: 14, fontWeight: '600', color: COLORS.text, flex: 1 }} numberOfLines={1}>
                          {displayTitle}
                        </Text>
                        {hasRedDot && (
                          <View style={{
                            width: 10, height: 10, borderRadius: 5,
                            backgroundColor: COLORS.red, marginLeft: 6,
                          }} />
                        )}
                      </View>
                      <Text style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 2 }}>
                        {isNote ? '学习纪要' : '资料'} · {formatDate(record.created_at)}
                      </Text>
                      {record.papercore ? (
                        <Text style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }} numberOfLines={1}>
                          {record.papercore}
                        </Text>
                      ) : null}
                      {record.logical_path ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                          <Feather name="folder" size={10} color={COLORS.primary} />
                          <Text style={{ fontSize: 10, color: COLORS.primary, marginLeft: 4 }}>{record.logical_path}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Feather name="chevron-right" size={16} color={COLORS.textMuted} />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

// File picker helper (supports all file types: PDF, PPT, DOC, images, etc.)
async function selectFile(): Promise<{ uri: string; name: string; type: string } | null> {
  try {
    console.log('[selectFile] Calling DocumentPicker.getDocumentAsync...');
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
    });
    console.log('[selectFile] Result:', JSON.stringify({ canceled: result.canceled, assetsCount: result.assets?.length }));
    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      console.log('[selectFile] Asset:', { name: asset.name, mimeType: asset.mimeType, uriPrefix: asset.uri?.slice(0, 40) });
      return {
        uri: asset.uri,
        name: asset.name || 'uploaded_file',
        type: asset.mimeType || 'application/octet-stream',
      };
    }
  } catch (e: any) {
    console.error('[selectFile] Error:', e?.message || e);
    throw e; // let caller handle the alert
  }
  return null;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days}天前`;
  return date.toLocaleDateString();
}
