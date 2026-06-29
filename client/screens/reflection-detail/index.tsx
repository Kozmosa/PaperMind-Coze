import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Screen } from '@/components/layout/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';

type Reflection = {
  id: number;
  learning_behavior: string;
  challenge_report: string;
  thinking_pattern: string;
  suggestion: string;
  period: string;
  created_at: string;
};

export default function ReflectionDetailScreen() {
  const { id } = useSafeSearchParams<{ id: number }>();
  const router = useSafeRouter();
  const [reflection, setReflection] = useState<Reflection | null>(null);

  const loadReflection = useCallback(async () => {
    try {
      if (!id) return;
      const res = await api.getReflection(id);
      setReflection(res.data);
    } catch (e) {
      console.error(e);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      loadReflection();
    }, [loadReflection])
  );

  if (!reflection) {
    return (
      <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
        <View className="flex-1 items-center justify-center">
          <Text style={{ color: '#B2BEC3' }}>加载中...</Text>
        </View>
      </Screen>
    );
  }

  const sections = [
    { title: '学习行为总结', key: 'learning_behavior', icon: 'activity' as const, color: '#6C63FF', content: reflection.learning_behavior },
    { title: '攻克问题报告', key: 'challenge_report', icon: 'check-circle' as const, color: '#00B894', content: reflection.challenge_report },
    { title: '思维模式总结', key: 'thinking_pattern', icon: 'box' as const, color: '#FF6B9D', content: reflection.thinking_pattern },
    { title: '学习建议', key: 'suggestion', icon: 'zap' as const, color: '#FDCB6E', content: reflection.suggestion },
  ];

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100, paddingTop: 16 }}
      >
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 24 }}>
          <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
            <Feather name="arrow-left" size={24} color="#2D3436" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: '#2D3436' }}>学习反思报告</Text>
            <Text style={{ fontSize: 13, color: '#636E72', marginTop: 2 }}>
              {reflection.period} · {new Date(reflection.created_at).toLocaleDateString()}
            </Text>
          </View>
        </View>

        {sections.map((section, i) => (
          <View key={section.key} style={{
            backgroundColor: '#F0F0F3',
            borderRadius: 24,
            padding: 20,
            marginBottom: 16,
            shadowColor: '#D1D9E6',
            shadowOffset: { width: 4, height: 4 },
            shadowOpacity: 0.6,
            shadowRadius: 6,
            elevation: 4,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <View style={{
                width: 36, height: 36, borderRadius: 18,
                backgroundColor: `${section.color}18`,
                justifyContent: 'center', alignItems: 'center',
              }}>
                <Feather name={section.icon} size={18} color={section.color} />
              </View>
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#2D3436', marginLeft: 10 }}>
                {section.title}
              </Text>
            </View>
            <Text style={{
              fontSize: 15,
              color: '#2D3436',
              lineHeight: 24,
              opacity: section.content ? 1 : 0.4,
            }}>
              {section.content || '暂无内容'}
            </Text>
          </View>
        ))}

        <View style={{ alignItems: 'center', paddingVertical: 12 }}>
          <Text style={{ fontSize: 12, color: '#B2BEC3' }}>
            系统生成于 {new Date(reflection.created_at).toLocaleString()}
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}