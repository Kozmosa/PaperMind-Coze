import { View, Text, ScrollView, TouchableOpacity, TextInput, Modal, Platform, KeyboardAvoidingView, Keyboard } from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';
import { LinearGradient } from 'expo-linear-gradient';

type Stickynote = {
  id: number;
  papercore: string;
  original_material: string | null;
  author_name: string;
  visibility: string;
  created_at: string;
};

type Forum = {
  id: number;
  name: string;
  type: string;
  description: string | null;
};

export default function CommunityScreen() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<'friends' | 'public' | 'forums'>('public');
  const [stickynotes, setStickynotes] = useState<Stickynote[]>([]);
  const [forums, setForums] = useState<Forum[]>([]);
  const [postModal, setPostModal] = useState(false);
  const [newPapercore, setNewPapercore] = useState('');
  const [newMaterial, setNewMaterial] = useState('');
  const [forumModal, setForumModal] = useState(false);
  const [forumName, setForumName] = useState('');
  const [forumType, setForumType] = useState<'school' | 'college' | 'class'>('school');

  const loadData = useCallback(async () => {
    try {
      if (activeTab === 'forums') {
        const res = await api.getForums();
        setForums(res.data || []);
      } else {
        const visibility = activeTab === 'friends' ? 'friends' : 'public';
        const res = await api.getStickynotes(visibility);
        setStickynotes(res.data || []);
      }
    } catch (e) {
      console.error(e);
    }
  }, [activeTab]);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const handlePostStickynote = async () => {
    if (!newPapercore.trim()) return;
    try {
      await api.createStickynote({
        papercore: newPapercore,
        original_material: newMaterial || undefined,
        visibility: activeTab === 'friends' ? 'friends' : 'public',
        author_name: 'Papermind 用户',
      });
      setNewPapercore('');
      setNewMaterial('');
      setPostModal(false);
      loadData();
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateForum = async () => {
    if (!forumName.trim()) return;
    try {
      await api.createForum({ name: forumName, type: forumType });
      setForumName('');
      setForumModal(false);
      loadData();
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteStickynote = async (id: number) => {
    try {
      await api.deleteStickynote(id);
      loadData();
    } catch (e) {
      console.error(e);
    }
  };

  const tabs = [
    { key: 'public', label: '社区', icon: 'globe' as const },
    { key: 'friends', label: '好友区', icon: 'users' as const },
    { key: 'forums', label: '论坛', icon: 'message-square' as const },
  ];

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
      <View className="flex-1">
        {/* Fixed Header */}
        <View style={{ paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 4 }}>
          <Text style={{ fontSize: 28, fontWeight: '800', color: '#2D3436' }}>省流墙</Text>
          <Text style={{ fontSize: 14, color: '#636E72', marginTop: 4 }}>
            分享知识，连接思维
          </Text>

          {/* Tab Bar */}
          <View style={{
            backgroundColor: '#E8E8EB',
            borderRadius: 16,
            padding: 4,
            flexDirection: 'row',
            marginTop: 12,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.6)',
          }}>
          {tabs.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={{
                flex: 1,
                paddingVertical: 10,
                borderRadius: 14,
                backgroundColor: activeTab === tab.key ? '#F0F0F3' : 'transparent',
                alignItems: 'center',
                flexDirection: 'row',
                justifyContent: 'center',
                gap: 6,
                shadowColor: activeTab === tab.key ? '#D1D9E6' : 'transparent',
                shadowOffset: { width: 2, height: 2 },
                shadowOpacity: 0.4,
                shadowRadius: 4,
                elevation: activeTab === tab.key ? 2 : 0,
              }}
              onPress={() => setActiveTab(tab.key as any)}
            >
              <Feather name={tab.icon} size={14} color={activeTab === tab.key ? '#6C63FF' : '#B2BEC3'} />
              <Text style={{
                fontSize: 13,
                fontWeight: '600',
                color: activeTab === tab.key ? '#6C63FF' : '#636E72',
              }}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Content */}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
      >
        {activeTab === 'forums' ? (
          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436' }}>论坛列表</Text>
              <TouchableOpacity onPress={() => setForumModal(true)}>
                <View style={{ backgroundColor: '#6C63FF', borderRadius: 9999, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Feather name="plus" size={14} color="#FFF" />
                  <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 13 }}>新建</Text>
                </View>
              </TouchableOpacity>
            </View>

            {forums.length === 0 && (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Feather name="message-square" size={48} color="#B2BEC3" />
                <Text style={{ fontSize: 14, color: '#636E72', marginTop: 12 }}>还没有论坛</Text>
              </View>
            )}

            {forums.map((forum) => (
              <TouchableOpacity
                key={forum.id}
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
                onPress={() => router.push('/forum-detail', { id: forum.id, name: forum.name })}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{
                    width: 44, height: 44, borderRadius: 22,
                    backgroundColor: 'rgba(108,99,255,0.12)',
                    justifyContent: 'center', alignItems: 'center',
                  }}>
                    <Feather name="message-square" size={20} color="#6C63FF" />
                  </View>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: '#2D3436' }}>{forum.name}</Text>
                    <Text style={{ fontSize: 12, color: '#636E72', marginTop: 2 }}>
                      {forum.type === 'school' ? '学校论坛' : forum.type === 'college' ? '学院论坛' : '班级论坛'}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={18} color="#B2BEC3" />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        ) : (
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: 120 }}
            showsVerticalScrollIndicator={false}
          >
            {stickynotes.length === 0 && (
              <View style={{ alignItems: 'center', paddingVertical: 40 }}>
                <Feather name="inbox" size={48} color="#B2BEC3" />
                <Text style={{ fontSize: 14, color: '#636E72', marginTop: 12 }}>
                  {activeTab === 'friends' ? '好友区暂无内容' : '社区暂无内容'}
                </Text>
                <Text style={{ fontSize: 12, color: '#B2BEC3', marginTop: 4 }}>点击下方按钮发布第一条便利贴</Text>
              </View>
            )}

            {stickynotes.map((note) => (
              <TouchableOpacity
                key={note.id}
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
                onLongPress={() => handleDeleteStickynote(note.id)}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                  <View style={{
                    width: 32, height: 32, borderRadius: 16,
                    backgroundColor: 'rgba(255,107,157,0.12)',
                    justifyContent: 'center', alignItems: 'center',
                  }}>
                    <Feather name="user" size={16} color="#FF6B9D" />
                  </View>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#2D3436', marginLeft: 8, flex: 1 }}>
                    {note.author_name}
                  </Text>
                  <Text style={{ fontSize: 11, color: '#B2BEC3' }}>
                    {new Date(note.created_at).toLocaleDateString()}
                  </Text>
                </View>
                <Text style={{ fontSize: 15, color: '#2D3436', lineHeight: 22 }}>{note.papercore}</Text>
                {note.original_material && (
                  <View style={{
                    marginTop: 10,
                    backgroundColor: '#E8E8EB',
                    borderRadius: 12,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.6)',
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Feather name="link" size={12} color="#636E72" />
                        <Text style={{ fontSize: 12, color: '#636E72' }}>{note.original_material}</Text>
                      </View>
                  </View>
                )}
                <View style={{ flexDirection: 'row', marginTop: 10, gap: 8 }}>
                  <View style={{
                    backgroundColor: 'rgba(108,99,255,0.08)',
                    borderRadius: 9999,
                    paddingHorizontal: 10, paddingVertical: 3,
                  }}>
                    <Text style={{ fontSize: 11, color: '#6C63FF', fontWeight: '500' }}>
                      {note.visibility === 'friends' ? '好友可见' : '公开'}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        </ScrollView>

        {/* FAB - Post Stickynote */}
        {activeTab !== 'forums' && (
          <TouchableOpacity
            style={{
              position: 'absolute',
              bottom: 90,
              right: 20,
            }}
            onPress={() => setPostModal(true)}
          >
            <LinearGradient
              colors={['#6C63FF', '#896BFF']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={{
                width: 56, height: 56, borderRadius: 28,
                justifyContent: 'center', alignItems: 'center',
                shadowColor: '#6C63FF',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.35,
                shadowRadius: 8,
                elevation: 6,
              }}
            >
              <Feather name="plus" size={24} color="#FFF" />
            </LinearGradient>
          </TouchableOpacity>
        )}

        {/* Post Modal */}
        <Modal visible={postModal} transparent animationType="slide">
          <TouchableOpacity
            style={{ flex: 1 }}
            activeOpacity={1}
            onPress={Keyboard.dismiss}
          >
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
                shadowColor: '#D1D9E6',
                shadowOffset: { width: 0, height: -4 },
                shadowOpacity: 0.5,
                shadowRadius: 8,
                elevation: 10,
              }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436' }}>发布便利贴</Text>
                  <TouchableOpacity onPress={() => setPostModal(false)}>
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
                    style={{ fontSize: 15, color: '#2D3436', minHeight: 80 }}
                    placeholder="写下你的知识分享..."
                    placeholderTextColor="#B2BEC3"
                    multiline
                    value={newPapercore}
                    onChangeText={setNewPapercore}
                  />
                </View>

                <View style={{
                  backgroundColor: '#E8E8EB',
                  borderRadius: 16,
                  padding: 14,
                  marginBottom: 20,
                  borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.6)',
                }}>
                  <TextInput
                    style={{ fontSize: 15, color: '#2D3436' }}
                    placeholder="附加原始资料（可选）"
                    placeholderTextColor="#B2BEC3"
                    value={newMaterial}
                    onChangeText={setNewMaterial}
                  />
                </View>

                <TouchableOpacity
                  style={{ borderRadius: 9999, overflow: 'hidden' }}
                  onPress={handlePostStickynote}
                >
                  <LinearGradient
                    colors={['#6C63FF', '#896BFF']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={{ paddingVertical: 16, alignItems: 'center' }}
                  >
                    <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 16 }}>发布</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </TouchableOpacity>
        </Modal>

        {/* Create Forum Modal */}
        <Modal visible={forumModal} transparent animationType="slide">
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
                  <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436' }}>新建论坛</Text>
                  <TouchableOpacity onPress={() => setForumModal(false)}>
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
                    style={{ fontSize: 15, color: '#2D3436' }}
                    placeholder="论坛名称"
                    placeholderTextColor="#B2BEC3"
                    value={forumName}
                    onChangeText={setForumName}
                  />
                </View>

                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
                  {(['school', 'college', 'class'] as const).map((type) => (
                    <TouchableOpacity
                      key={type}
                      style={{
                        flex: 1,
                        paddingVertical: 10,
                        borderRadius: 14,
                        backgroundColor: forumType === type ? '#6C63FF' : '#E8E8EB',
                        alignItems: 'center',
                        borderWidth: 1,
                        borderColor: forumType === type ? '#6C63FF' : 'rgba(255,255,255,0.6)',
                      }}
                      onPress={() => setForumType(type)}
                    >
                      <Text style={{
                        fontSize: 13,
                        fontWeight: '600',
                        color: forumType === type ? '#FFF' : '#636E72',
                      }}>
                        {type === 'school' ? '学校' : type === 'college' ? '学院' : '班级'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <TouchableOpacity
                  style={{ borderRadius: 9999, overflow: 'hidden' }}
                  onPress={handleCreateForum}
                >
                  <LinearGradient
                    colors={['#6C63FF', '#896BFF']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={{ paddingVertical: 16, alignItems: 'center' }}
                  >
                    <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 16 }}>创建论坛</Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </TouchableOpacity>
        </Modal>
      </View>
    </Screen>
  );
}