import { View, Text, ScrollView, TouchableOpacity, TextInput, Modal, Platform, KeyboardAvoidingView, Keyboard, Alert } from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';

type PapernoteStyle = {
  id: number;
  general_preference: string;
  subject_preferences: Record<string, string>;
  updated_at: string;
};

type Reflection = {
  id: number;
  learning_behavior: string;
  challenge_report: string;
  thinking_pattern: string;
  suggestion: string;
  period: string;
  created_at: string;
};

export default function ProfileScreen() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const [style, setStyle] = useState<PapernoteStyle | null>(null);
  const [reflections, setReflections] = useState<Reflection[]>([]);
  const [draftCount, setDraftCount] = useState(0);
  const [styleModal, setStyleModal] = useState(false);
  const [editGeneral, setEditGeneral] = useState('');

  const loadData = useCallback(async () => {
    try {
      const [styleRes, reflectRes, draftRes, problemRes] = await Promise.all([
        api.getPapernoteStyle(),
        api.getReflections(),
        api.getDrafts(),
      ]);
      setStyle(styleRes.data || null);
      setReflections(reflectRes.data || []);
      setDraftCount((draftRes.data || []).filter((d: any) => d.status === 'unprocessed').length);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const handleSaveStyle = async () => {
    try {
      if (style) {
        await api.updatePapernoteStyle({ general_preference: editGeneral });
      } else {
        await api.createPapernoteStyle({ general_preference: editGeneral });
      }
      setStyleModal(false);
      loadData();
    } catch (e) {
      console.error(e);
    }
  };

  const sections = [
    {
      key: 'draft',
      icon: 'edit-3' as const,
      title: '原始草稿池',
      badge: draftCount > 0 ? `${draftCount} 条待处理` : undefined,
      onPress: () => router.push('/draft-pool'),
    },
    {
      key: 'style',
      icon: 'feather' as const,
      title: '笔记风格偏好',
      badge: style?.general_preference ? '已设置' : '未设置',
      onPress: () => {
        setEditGeneral(style?.general_preference || '');
        setStyleModal(true);
      },
    },
    {
      key: 'reflections',
      icon: 'bar-chart-2' as const,
      title: '学习反思',
      badge: reflections.length > 0 ? `${reflections.length} 份` : undefined,
      onPress: () => {
        router.push('/reflection');
      },
    },
  ];

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
      <View className="flex-1">
        {/* Fixed Profile Header */}
        <View style={{ paddingTop: insets.top + 20, paddingHorizontal: 20, paddingBottom: 8, alignItems: 'center' }}>
          <View style={{
            width: 80, height: 80, borderRadius: 40,
            backgroundColor: '#F0F0F3',
            justifyContent: 'center', alignItems: 'center',
            shadowColor: '#D1D9E6',
            shadowOffset: { width: 4, height: 4 },
            shadowOpacity: 0.6,
            shadowRadius: 8,
            elevation: 5,
            borderWidth: 3,
            borderColor: '#FFFFFF',
          }}>
            <Feather name="user" size={36} color="#6C63FF" />
          </View>
          <Text style={{ fontSize: 22, fontWeight: '800', color: '#2D3436', marginTop: 12 }}>我的学习</Text>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
        >

        {/* Stats Card */}
        <View style={{
          backgroundColor: '#F0F0F3',
          borderRadius: 24,
          padding: 20,
          marginBottom: 24,
          shadowColor: '#D1D9E6',
          shadowOffset: { width: 4, height: 4 },
          shadowOpacity: 0.6,
          shadowRadius: 6,
          elevation: 4,
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 28, fontWeight: '800', color: '#6C63FF' }}>--</Text>
              <Text style={{ fontSize: 12, color: '#636E72' }}>知识节点</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 28, fontWeight: '800', color: '#00B894' }}>{reflections.length}</Text>
              <Text style={{ fontSize: 12, color: '#636E72' }}>反思报告</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 28, fontWeight: '800', color: '#FF6B9D' }}>{draftCount}</Text>
              <Text style={{ fontSize: 12, color: '#636E72' }}>待处理草稿</Text>
            </View>
          </View>
        </View>

        {/* Menu Items */}
        {sections.map((section, i) => (
          <TouchableOpacity
            key={section.key}
            style={{
              backgroundColor: '#F0F0F3',
              borderRadius: 20,
              padding: 16,
              marginBottom: 12,
              shadowColor: '#D1D9E6',
              shadowOffset: { width: 4, height: 4 },
              shadowOpacity: 0.6,
              shadowRadius: 6,
              elevation: 4,
            }}
            onPress={section.onPress}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{
                width: 44, height: 44, borderRadius: 22,
                backgroundColor: i === 0 ? 'rgba(108,99,255,0.10)' :
                  i === 1 ? 'rgba(0,184,148,0.10)' :
                  i === 2 ? 'rgba(255,107,157,0.10)' : 'rgba(253,203,110,0.10)',
                justifyContent: 'center', alignItems: 'center',
              }}>
                <Feather name={section.icon} size={20} color={
                  i === 0 ? '#6C63FF' : i === 1 ? '#00B894' : i === 2 ? '#FF6B9D' : '#FDCB6E'
                } />
              </View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={{ fontSize: 16, fontWeight: '600', color: '#2D3436' }}>{section.title}</Text>
              </View>
              {section.badge && (
                <View style={{
                  backgroundColor: 'rgba(108,99,255,0.08)',
                  borderRadius: 9999,
                  paddingHorizontal: 10,
                  paddingVertical: 3,
                  marginRight: 8,
                }}>
                  <Text style={{ fontSize: 11, color: '#6C63FF', fontWeight: '500' }}>{section.badge}</Text>
                </View>
              )}
              <Feather name="chevron-right" size={18} color="#B2BEC3" />
            </View>
          </TouchableOpacity>
        ))}

        {/* Reflections Section */}
        {reflections.length > 0 && (
          <View style={{
            backgroundColor: '#F0F0F3',
            borderRadius: 24,
            padding: 20,
            marginTop: 8,
            marginBottom: 24,
            shadowColor: '#D1D9E6',
            shadowOffset: { width: 4, height: 4 },
            shadowOpacity: 0.6,
            shadowRadius: 6,
            elevation: 4,
          }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436', marginBottom: 16 }}>
              学习反思报告
            </Text>
            {reflections.slice(0, 3).map((ref) => (
              <TouchableOpacity
                key={ref.id}
                style={{
                  paddingVertical: 12,
                  borderBottomWidth: ref.id !== reflections.slice(0, 3)[reflections.slice(0, 3).length - 1]?.id ? 1 : 0,
                  borderBottomColor: 'rgba(0,0,0,0.04)',
                }}
                onPress={() => router.push('/reflection-detail', { id: ref.id })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Feather name="file-text" size={16} color="#6C63FF" />
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#2D3436', marginLeft: 8 }}>
                    {ref.period || `反思报告 #${ref.id}`}
                  </Text>
                  <View style={{ flex: 1 }} />
                  <Text style={{ fontSize: 12, color: '#B2BEC3' }}>
                    {new Date(ref.created_at).toLocaleDateString()}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Style Modal */}
        <Modal visible={styleModal} transparent animationType="slide">
          <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={Keyboard.dismiss}>
            <KeyboardAvoidingView
              style={{ flex: 1, justifyContent: 'flex-end' }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              <View style={{
                backgroundColor: '#F0F0F3',
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                padding: 24,
                paddingBottom: Platform.OS === 'ios' ? 40 : 24,
              }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436' }}>笔记风格偏好</Text>
                  <TouchableOpacity onPress={() => setStyleModal(false)}>
                    <Feather name="x" size={22} color="#B2BEC3" />
                  </TouchableOpacity>
                </View>

                <View style={{
                  backgroundColor: '#E8E8EB',
                  borderRadius: 16,
                  padding: 14,
                  marginBottom: 12,
                  borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.6)',
                }}>
                  <TextInput
                    style={{ fontSize: 15, color: '#2D3436', minHeight: 120 }}
                    placeholder="描述你的笔记偏好，如：喜欢用思维导图、善于总结关键词..."
                    placeholderTextColor="#B2BEC3"
                    multiline
                    value={editGeneral}
                    onChangeText={setEditGeneral}
                  />
                </View>

                <TouchableOpacity
                  style={{ borderRadius: 9999, overflow: 'hidden' }}
                  onPress={handleSaveStyle}
                >
                  <LinearGradient
                    colors={['#6C63FF', '#896BFF']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={{ paddingVertical: 16, alignItems: 'center' }}
                  >
                    <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 16 }}>保存偏好</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </TouchableOpacity>
        </Modal>
      </ScrollView>
      </View>
    </Screen>
  );
}