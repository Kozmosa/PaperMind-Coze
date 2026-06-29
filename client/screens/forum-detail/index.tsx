import { View, Text, ScrollView, TouchableOpacity, TextInput, Modal, Platform, KeyboardAvoidingView, Keyboard } from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@/components/layout/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';

type ForumPost = {
  id: number;
  content: string;
  author_name: string;
  created_at: string;
};

export default function ForumDetailScreen() {
  const { id, name } = useSafeSearchParams<{ id: number; name: string }>();
  const router = useSafeRouter();
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [postModal, setPostModal] = useState(false);
  const [newContent, setNewContent] = useState('');

  const loadPosts = useCallback(async () => {
    try {
      const res = await api.getForumPosts(id);
      setPosts(res.data || []);
    } catch (e) {
      console.error(e);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      if (id) loadPosts();
    }, [loadPosts])
  );

  const handlePost = async () => {
    if (!newContent.trim()) return;
    try {
      await api.createForumPost({ forum_id: id, title: '帖子', content: newContent, author_name: 'Papermind 用户' });
      setNewContent('');
      setPostModal(false);
      loadPosts();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
      <View className="flex-1" style={{ paddingHorizontal: 20, paddingTop: 16 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
          <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
            <Feather name="arrow-left" size={24} color="#2D3436" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: '#2D3436' }}>{name}</Text>
            <Text style={{ fontSize: 13, color: '#636E72', marginTop: 2 }}>{posts.length} 个帖子</Text>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
        >
          {posts.length === 0 && (
            <View style={{ alignItems: 'center', paddingVertical: 60 }}>
              <Feather name="message-circle" size={48} color="#B2BEC3" />
              <Text style={{ fontSize: 14, color: '#636E72', marginTop: 12 }}>还没有帖子</Text>
              <Text style={{ fontSize: 12, color: '#B2BEC3', marginTop: 4 }}>快来发布第一条帖子吧</Text>
            </View>
          )}

          {posts.map((post) => (
            <View key={post.id} style={{
              backgroundColor: '#F0F0F3',
              borderRadius: 20,
              padding: 16,
              marginBottom: 12,
              shadowColor: '#D1D9E6',
              shadowOffset: { width: 4, height: 4 },
              shadowOpacity: 0.6,
              shadowRadius: 6,
              elevation: 4,
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <View style={{
                  width: 32, height: 32, borderRadius: 16,
                  backgroundColor: 'rgba(108,99,255,0.12)',
                  justifyContent: 'center', alignItems: 'center',
                }}>
                  <Feather name="user" size={16} color="#6C63FF" />
                </View>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#2D3436', marginLeft: 8, flex: 1 }}>
                  {post.author_name}
                </Text>
                <Text style={{ fontSize: 11, color: '#B2BEC3' }}>
                  {new Date(post.created_at).toLocaleDateString()}
                </Text>
              </View>
              <Text style={{ fontSize: 15, color: '#2D3436', lineHeight: 24 }}>{post.content}</Text>
            </View>
          ))}
        </ScrollView>

        {/* FAB */}
        <TouchableOpacity
          style={{ position: 'absolute', bottom: 90, right: 20 }}
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

        {/* Post Modal */}
        <Modal visible={postModal} transparent animationType="slide">
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
                  <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436' }}>发布帖子</Text>
                  <TouchableOpacity onPress={() => setPostModal(false)}>
                    <Feather name="x" size={22} color="#B2BEC3" />
                  </TouchableOpacity>
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
                    style={{ fontSize: 15, color: '#2D3436', minHeight: 120 }}
                    placeholder="写下你的想法..."
                    placeholderTextColor="#B2BEC3"
                    multiline
                    value={newContent}
                    onChangeText={setNewContent}
                  />
                </View>

                <TouchableOpacity
                  style={{ borderRadius: 9999, overflow: 'hidden' }}
                  onPress={handlePost}
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
      </View>
    </Screen>
  );
}