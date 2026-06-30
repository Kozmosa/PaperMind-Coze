import { View, Text, ScrollView, TouchableOpacity, Dimensions } from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { LineChart } from 'react-native-chart-kit';
import { Screen } from '@/components/layout/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { api } from '@/utils/api';

const { width: SCREEN_W } = Dimensions.get('window');

type Reflection = {
  id: number;
  learning_behavior: string;
  challenge_report: string;
  thinking_pattern: string;
  suggestion: string;
  period: string;
  created_at: string;
};

type DailyCount = {
  date: string;
  count: number;
};

function getDaysFromPeriod(period: string): number {
  if (period.includes('3')) return 3;
  if (period.includes('30')) return 30;
  return 7;
}

function formatStatsForChart(daily: Record<string, number>, period: string): DailyCount[] {
  const days = getDaysFromPeriod(period);
  const result: DailyCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    result.push({ date: key, count: daily[key] || 0 });
  }
  return result;
}

export default function ReflectionDetailScreen() {
  const { id } = useSafeSearchParams<{ id: number }>();
  const router = useSafeRouter();
  const [reflection, setReflection] = useState<Reflection | null>(null);
  const [dailyCounts, setDailyCounts] = useState<DailyCount[]>([]);

  const loadReflection = useCallback(async () => {
    try {
      if (!id) return;
      const res = await api.getReflection(id);
      const r = res.data as Reflection;
      setReflection(r);

      // Fetch Q&A activity stats matching the reflection period
      const days = getDaysFromPeriod(r.period);
      const statsRes = await api.getProblemSolvingStats(days);
      const daily: Record<string, number> = statsRes.data?.daily || {};
      setDailyCounts(formatStatsForChart(daily, r.period));
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

  const totalQaCount = dailyCounts.reduce((sum, d) => sum + d.count, 0);
  const activeDays = dailyCounts.filter(d => d.count > 0).length;

  const chartData = {
    labels: dailyCounts.map(d => {
      // Show every Nth label to avoid crowding
      const parts = d.date.split('-');
      return `${parts[1]}/${parts[2]}`;
    }),
    datasets: [{
      data: dailyCounts.map(d => d.count),
      color: (opacity = 1) => `rgba(108, 99, 255, ${opacity})`,
      strokeWidth: 2,
    }],
  };

  const chartConfig = {
    backgroundColor: '#FFFFFF',
    backgroundGradientFrom: '#FFFFFF',
    backgroundGradientTo: '#FFFFFF',
    color: (opacity = 1) => `rgba(108, 99, 255, ${opacity})`,
    labelColor: (opacity = 1) => `rgba(99, 110, 114, ${opacity})`,
    strokeWidth: 2,
    decimalCount: 0,
    propsForBackgroundLines: {
      stroke: '#F0F0F3',
      strokeDasharray: '4 4',
      strokeWidth: 1,
    },
    propsForLabels: {
      fontSize: 10,
    },
  };

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

        {/* 问题解答活动折线图 */}
        <View style={{
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
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <View style={{
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: '#6C63FF18',
              justifyContent: 'center', alignItems: 'center',
            }}>
              <Feather name="trending-up" size={18} color="#6C63FF" />
            </View>
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#2D3436', marginLeft: 10 }}>
              问题解答活跃度（折线图）
            </Text>
          </View>

          {/* Summary stats row */}
          <View style={{ flexDirection: 'row', marginBottom: 16 }}>
            <View style={{ flex: 1, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12, alignItems: 'center', marginRight: 8 }}>
              <Text style={{ fontSize: 22, fontWeight: '800', color: '#6C63FF' }}>{totalQaCount}</Text>
              <Text style={{ fontSize: 11, color: '#636E72', marginTop: 2 }}>提问总数</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 12, alignItems: 'center', marginLeft: 8 }}>
              <Text style={{ fontSize: 22, fontWeight: '800', color: '#00B894' }}>{activeDays}</Text>
              <Text style={{ fontSize: 11, color: '#636E72', marginTop: 2 }}>活跃天数</Text>
            </View>
          </View>

          {dailyCounts.length > 0 && totalQaCount > 0 ? (
            <View style={{ alignItems: 'center' }}>
              <LineChart
                data={chartData}
                width={SCREEN_W - 80}
                height={200}
                chartConfig={chartConfig}
                bezier
                withDots={true}
                withShadow={false}
                withInnerLines={true}
                withOuterLines={false}
                withVerticalLines={false}
                withHorizontalLines={true}
                withVerticalLabels={true}
                withHorizontalLabels={true}
                fromZero
                style={{ borderRadius: 12 }}
              />
            </View>
          ) : (
            <View style={{ backgroundColor: '#FFFFFF', borderRadius: 12, padding: 24, alignItems: 'center' }}>
              <Feather name="bar-chart-2" size={32} color="#D1D9E6" />
              <Text style={{ color: '#B2BEC3', marginTop: 8, fontSize: 13 }}>
                该时间段内暂无问答活动数据
              </Text>
            </View>
          )}
        </View>

        <View style={{ alignItems: 'center', paddingVertical: 12 }}>
          <Text style={{ fontSize: 12, color: '#B2BEC3' }}>
            系统生成于 {new Date(reflection.created_at).toLocaleString()}
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}