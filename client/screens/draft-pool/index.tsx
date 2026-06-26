import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';
import * as DocumentPicker from 'expo-document-picker';

type DraftItem = {
  id: number;
  content: string;
  file_url: string | null;
  status: string;
  created_at: string;
};

export default function DraftPoolScreen() {
  const router = useSafeRouter();
  const [drafts, setDrafts] = useState<DraftItem[]>([]);

  const loadDrafts = useCallback(async () => {
    try {
      const res = await api.getDrafts();
      setDrafts(res.data || []);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const [uploading, setUploading] = useState(false);

  const uploadFile = async (file: { uri: string; name: string; mimeType: string }) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: file.uri,
        name: file.name,
        type: file.mimeType || 'application/octet-stream',
      } as any);
      const res = await fetch(`${process.env.EXPO_PUBLIC_BACKEND_BASE_URL}/api/v1/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.fileUrl) {
        await api.createDraft({ content: `[上传文件] ${file.name}`, file_url: data.fileUrl });
        loadDrafts();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setUploading(false);
    }
  };

  const handleUploadFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/markdown', 'text/plain'],
        copyToCacheDirectory: true,
      });
      if (!result.canceled && result.assets?.[0]) {
        await uploadFile(result.assets[0]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadDrafts();
    }, [loadDrafts])
  );

  const handleDelete = (id: number) => {
    Alert.alert('确认删除', '确定要删除这个草稿吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteDraft(id);
            loadDrafts();
          } catch (e) {
            console.error(e);
          }
        },
      },
    ]);
  };

  const handleProcessToNode = (draft: DraftItem) => {
    router.push('/knowledge-node-edit', { draftId: draft.id });
  };

  const unprocessed = drafts.filter(d => d.status === 'unprocessed');
  const processed = drafts.filter(d => d.status !== 'unprocessed');

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
      <View className="flex-1" style={{ paddingHorizontal: 20, paddingTop: 16 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
          <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
            <Feather name="arrow-left" size={24} color="#2D3436" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: '#2D3436' }}>原始草稿池</Text>
            <Text style={{ fontSize: 13, color: '#636E72', marginTop: 2 }}>
              {drafts.length} 条草稿 · {unprocessed.length} 条待处理
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleUploadFile}
            style={{
              backgroundColor: '#D97757',
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 20,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <Feather name="upload" size={16} color="#FFFFFF" />
            <Text style={{ fontSize: 12, fontWeight: '600', color: '#FFFFFF' }}>上传文件</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Unprocessed Section */}
          {unprocessed.length > 0 && (
            <View style={{ marginBottom: 24 }}>
              <View style={{
                backgroundColor: '#FF6B9D',
                borderRadius: 9999,
                paddingHorizontal: 12,
                paddingVertical: 4,
                alignSelf: 'flex-start',
                marginBottom: 12,
              }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: '#FFF' }}>待处理</Text>
              </View>

              {unprocessed.map((draft) => (
                <View key={draft.id} style={{
                  backgroundColor: '#F0F0F3',
                  borderRadius: 20,
                  padding: 16,
                  marginBottom: 12,
                  shadowColor: '#D1D9E6',
                  shadowOffset: { width: 4, height: 4 },
                  shadowOpacity: 0.6,
                  shadowRadius: 6,
                  elevation: 4,
                  borderLeftWidth: 4,
                  borderLeftColor: '#FF6B9D',
                }}>
                  <View style={{ flexDirection: 'row' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, color: '#2D3436', lineHeight: 22 }} numberOfLines={3}>
                        {draft.content}
                      </Text>
                      {draft.file_url && (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}>
                          <Feather name="link" size={12} color="#6C63FF" />
                          <Text style={{ fontSize: 12, color: '#6C63FF' }}>{draft.file_url}</Text>
                        </View>
                      )}
                      <Text style={{ fontSize: 11, color: '#B2BEC3', marginTop: 8 }}>
                        {new Date(draft.created_at).toLocaleString()}
                      </Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                    <TouchableOpacity
                      style={{
                        flex: 1,
                        backgroundColor: '#6C63FF',
                        borderRadius: 12,
                        paddingVertical: 10,
                        alignItems: 'center',
                      }}
                      onPress={() => handleProcessToNode(draft)}
                    >
                      <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 13 }}>整理成节点</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={{
                        backgroundColor: '#E8E8EB',
                        borderRadius: 12,
                        paddingVertical: 10,
                        paddingHorizontal: 16,
                        borderWidth: 1,
                        borderColor: 'rgba(255,255,255,0.6)',
                      }}
                      onPress={() => handleDelete(draft.id)}
                    >
                      <Feather name="trash-2" size={16} color="#FF6B6B" />
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Processed Section */}
          {processed.length > 0 && (
            <View>
              <View style={{
                backgroundColor: '#00B894',
                borderRadius: 9999,
                paddingHorizontal: 12,
                paddingVertical: 4,
                alignSelf: 'flex-start',
                marginBottom: 12,
              }}>
                <Text style={{ fontSize: 12, fontWeight: '600', color: '#FFF' }}>已处理</Text>
              </View>

              {processed.map((draft) => (
                <View key={draft.id} style={{
                  backgroundColor: '#F0F0F3',
                  borderRadius: 20,
                  padding: 16,
                  marginBottom: 12,
                  shadowColor: '#D1D9E6',
                  shadowOffset: { width: 4, height: 4 },
                  shadowOpacity: 0.6,
                  shadowRadius: 6,
                  elevation: 4,
                  borderLeftWidth: 4,
                  borderLeftColor: '#00B894',
                  opacity: 0.7,
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Feather name="check-circle" size={18} color="#00B894" />
                    <Text style={{ flex: 1, fontSize: 15, color: '#636E72', marginLeft: 10, textDecorationLine: 'line-through' }} numberOfLines={2}>
                      {draft.content}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11, color: '#B2BEC3', marginTop: 8, marginLeft: 28 }}>
                    {new Date(draft.created_at).toLocaleString()}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {drafts.length === 0 && (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Feather name="inbox" size={56} color="#B2BEC3" />
              <Text style={{ fontSize: 16, color: '#636E72', marginTop: 16, fontWeight: '600' }}>草稿池为空</Text>
              <Text style={{ fontSize: 13, color: '#B2BEC3', marginTop: 8, textAlign: 'center' }}>
                快速上传资料到草稿池，之后再整理成知识节点
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </Screen>
  );
}