import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Screen } from '@/components/layout/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';

type KnowledgeNode = {
  id: number;
  papercore: string;
  tags: string[];
  created_at: string;
};

type DraftItem = {
  id: number;
  content: string;
  status: string;
  created_at: string;
};

export default function HomeScreen() {
  const router = useSafeRouter();
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [stats, setStats] = useState({ total: 0, recent: 0, drafts: 0 });

  const loadData = async () => {
    try {
      const [nodeRes, draftRes] = await Promise.all([
        api.getKnowledgeNodes(),
        api.getDrafts(),
      ]);
      const nodeData = nodeRes.data || [];
      const draftData = draftRes.data || [];
      setNodes(nodeData);
      setDrafts(draftData);
      setStats({
        total: nodeData.length,
        recent: nodeData.filter((n: KnowledgeNode) => {
          const d = new Date(n.created_at);
          return d > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        }).length,
        drafts: draftData.filter((d: DraftItem) => d.status === 'unprocessed').length,
      });
    } catch (e) {
      console.error('Failed to load data', e);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const draftPoolItems = drafts.filter(d => d.status === 'unprocessed').slice(0, 3);

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
      >
        {/* Header */}
        <View style={{ paddingTop: 16, marginBottom: 24 }}>
          <Text style={{ fontSize: 28, fontWeight: '800', color: '#2D3436' }}>
            Papermind
          </Text>
          <Text style={{ fontSize: 14, color: '#636E72', marginTop: 4 }}>
            你的第二大脑书房
          </Text>
        </View>

        {/* Stats Row */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 24 }}>
          {[
            { label: '知识节点', value: stats.total, icon: 'book-open', color: '#6C63FF' },
            { label: '本周新增', value: stats.recent, icon: 'trending-up', color: '#00B894' },
            { label: '待处理草稿', value: stats.drafts, icon: 'file-text', color: '#FF6B9D' },
          ].map((item, i) => (
            <View key={i} style={{
              flex: 1,
              backgroundColor: '#F0F0F3',
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
              <Text style={{ fontSize: 24, fontWeight: '800', color: '#2D3436' }}>
                {item.value}
              </Text>
              <Text style={{ fontSize: 12, color: '#636E72', marginTop: 4 }}>
                {item.label}
              </Text>
            </View>
          ))}
        </View>

        {/* Quick Actions */}
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
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436', marginBottom: 16 }}>
            快捷操作
          </Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <TouchableOpacity
              style={{ flex: 1, alignItems: 'center', padding: 12, backgroundColor: '#E8E8EB', borderRadius: 16 }}
              onPress={() => router.push('/knowledge-node-edit')}
            >
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(108,99,255,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: 8 }}>
                <Feather name="plus" size={22} color="#6C63FF" />
              </View>
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#2D3436' }}>新建节点</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{ flex: 1, alignItems: 'center', padding: 12, backgroundColor: '#E8E8EB', borderRadius: 16 }}
              onPress={() => router.push('/knowledge-node-edit', { draftId: undefined })}
            >
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,107,157,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: 8 }}>
                <Feather name="edit-3" size={22} color="#FF6B9D" />
              </View>
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#2D3436' }}>知识笔记</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{ flex: 1, alignItems: 'center', padding: 12, backgroundColor: '#E8E8EB', borderRadius: 16 }}
              onPress={() => router.push('/knowledge')}
            >
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,184,148,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: 8 }}>
                <Feather name="git-branch" size={22} color="#00B894" />
              </View>
              <Text style={{ fontSize: 12, fontWeight: '600', color: '#2D3436' }}>知识图谱</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Draft Pool Alert */}
        {draftPoolItems.length > 0 && (
          <TouchableOpacity
            style={{
              backgroundColor: '#F0F0F3',
              borderRadius: 20,
              padding: 16,
              marginBottom: 24,
              shadowColor: '#D1D9E6',
              shadowOffset: { width: 4, height: 4 },
              shadowOpacity: 0.6,
              shadowRadius: 6,
              elevation: 4,
              borderLeftWidth: 4,
              borderLeftColor: '#FF6B9D',
            }}
            onPress={() => router.push('/profile')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Feather name="alert-circle" size={20} color="#FF6B9D" />
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#2D3436', marginLeft: 10, flex: 1 }}>
                待处理草稿
              </Text>
              <Text style={{ fontSize: 13, color: '#FF6B9D', fontWeight: '600' }}>
                {draftPoolItems.length} 条
              </Text>
            </View>
            {draftPoolItems.map((draft) => (
              <Text key={draft.id} style={{ fontSize: 13, color: '#636E72', marginTop: 8, paddingLeft: 30 }} numberOfLines={1}>
                {draft.content}
              </Text>
            ))}
          </TouchableOpacity>
        )}

        {/* Recent Nodes */}
        <View style={{
          backgroundColor: '#F0F0F3',
          borderRadius: 24,
          padding: 20,
          shadowColor: '#D1D9E6',
          shadowOffset: { width: 4, height: 4 },
          shadowOpacity: 0.6,
          shadowRadius: 6,
          elevation: 4,
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436' }}>
              最近学习
            </Text>
            <TouchableOpacity onPress={() => router.push('/knowledge')}>
              <Text style={{ fontSize: 14, color: '#6C63FF', fontWeight: '600' }}>查看全部 →</Text>
            </TouchableOpacity>
          </View>

          {nodes.length === 0 && (
            <View style={{ alignItems: 'center', paddingVertical: 24 }}>
              <Feather name="book" size={40} color="#B2BEC3" />
              <Text style={{ fontSize: 14, color: '#636E72', marginTop: 12 }}>
                还没有知识节点，快去创建吧！
              </Text>
              <TouchableOpacity
                style={{ marginTop: 16 }}
                onPress={() => router.push('/knowledge-node-edit')}
              >
                <LinearGradient
                  colors={['#6C63FF', '#896BFF']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={{ borderRadius: 9999, paddingVertical: 10, paddingHorizontal: 24 }}
                >
                  <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 14 }}>+ 新建节点</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}

          {nodes.slice(0, 5).map((node) => (
            <TouchableOpacity
              key={node.id}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 12,
                borderBottomWidth: node.id !== nodes.slice(0, 5)[nodes.slice(0, 5).length - 1]?.id ? 1 : 0,
                borderBottomColor: 'rgba(0,0,0,0.04)',
              }}
              onPress={() => router.push('/knowledge-node-detail', { id: node.id })}
            >
              <View style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: 'rgba(108,99,255,0.10)',
                justifyContent: 'center', alignItems: 'center',
              }}>
                <Feather name="file-text" size={18} color="#6C63FF" />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#2D3436' }} numberOfLines={1}>
                  {node.papercore}
                </Text>
                <Text style={{ fontSize: 12, color: '#636E72', marginTop: 2 }}>
                  {new Date(node.created_at).toLocaleDateString()}
                </Text>
              </View>
              <Feather name="chevron-right" size={18} color="#B2BEC3" />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}