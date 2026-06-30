import { View, Text, ScrollView, TouchableOpacity, Dimensions, ActivityIndicator } from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Feather, AntDesign } from '@expo/vector-icons';
import { LineChart } from 'react-native-chart-kit';
import { Screen } from '@/components/layout/Screen';
import { api } from '@/utils/api';
import { useSafeRouter } from '@/hooks/useSafeRouter';

const { width: SCREEN_W } = Dimensions.get('window');

type ProblemLog = {
  id: string;
  question: string;
  answer: string;
  steps: string;
  created_at: string;
  citation_snippets: any[];
};

type DailyCount = {
  date: string;
  count: number;
};

export default function ProblemSolvingLogsScreen() {
  const router = useSafeRouter();
  const [logs, setLogs] = useState<ProblemLog[]>([]);
  const [dailyCounts, setDailyCounts] = useState<DailyCount[]>([]);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  const loadData = async () => {
    setLoading(true);
    try {
      const [logsRes, statsRes] = await Promise.all([
        api.getProblemSolvingLogs(),
        api.getProblemSolvingStats(),
      ]);
      setLogs(logsRes.data || []);
      // Backend returns { total, daily: Record<string, number> }
      const daily = statsRes.data?.daily || {};
      const counts: DailyCount[] = Object.entries(daily)
        .map(([date, count]) => ({ date, count: count as number }))
        .sort((a, b) => a.date.localeCompare(b.date));
      setDailyCounts(counts);
    } catch (e) {
      console.error('Failed to load data', e);
    } finally {
      setLoading(false);
    }
  };

  const totalCount = logs.length;

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'top']}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#F0F0F3' }}>
        <TouchableOpacity onPress={() => router.back()}>
          <Feather name="arrow-left" size={24} color="#2D3436" />
        </TouchableOpacity>
        <Text style={{ marginLeft: 12, fontSize: 18, fontWeight: '700', color: '#2D3436', flex: 1 }}>
          问题解答日志
        </Text>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="#6C63FF" />
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          {/* Summary stats */}
          <View style={{ padding: 16 }}>
            <View style={{ backgroundColor: '#FFF', borderRadius: 16, padding: 20, marginBottom: 16 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#2D3436', marginBottom: 16 }}>
                <AntDesign name="pie-chart" size={16} color="#2D3436" /> 学习数据
              </Text>

              <View style={{ flexDirection: 'row', marginBottom: 20 }}>
                <View style={{ flex: 1, backgroundColor: '#F0F0F3', borderRadius: 12, padding: 16, alignItems: 'center' }}>
                  <Text style={{ fontSize: 32, fontWeight: '800', color: '#6C63FF' }}>{totalCount}</Text>
                  <Text style={{ fontSize: 13, color: '#636E72', marginTop: 4 }}>解决问题总数</Text>
                </View>
                <View style={{ width: 12 }} />
                <View style={{ flex: 1, backgroundColor: '#F0F0F3', borderRadius: 12, padding: 16, alignItems: 'center' }}>
                  <Text style={{ fontSize: 32, fontWeight: '800', color: '#00B894' }}>
                    {dailyCounts.length > 0 ? dailyCounts.length : 0}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#636E72', marginTop: 4 }}>活跃天数</Text>
                </View>
              </View>

              {/* Line chart */}
              {dailyCounts.length > 0 && (
                <View style={{ backgroundColor: '#F8F9FA', borderRadius: 12, padding: 16 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: '#2D3436', marginBottom: 12 }}>解决问题数量趋势</Text>
                  <LineChart
                    data={{
                      labels: dailyCounts.map(d => d.date.slice(5)),
                      datasets: [{
                        data: dailyCounts.map(d => d.count),
                        color: (opacity = 1) => `rgba(108, 99, 255, ${opacity})`,
                        strokeWidth: 2,
                      }],
                    }}
                    width={SCREEN_W - 96}
                    height={180}
                    chartConfig={{
                      backgroundColor: '#F8F9FA',
                      backgroundGradientFrom: '#F8F9FA',
                      backgroundGradientTo: '#F8F9FA',
                      color: (opacity = 1) => `rgba(108, 99, 255, ${opacity})`,
                      labelColor: (opacity = 1) => `rgba(178, 190, 195, ${opacity})`,
                      strokeWidth: 2,
                      decimalCount: 0,
                      propsForBackgroundLines: {
                        stroke: '#E8EAF0',
                        strokeDasharray: '4 4',
                        strokeWidth: 1,
                      },
                      propsForLabels: {
                        fontSize: 9,
                      },
                    }}
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
                    style={{ borderRadius: 8 }}
                  />
                </View>
              )}
            </View>

            {/* Logs list */}
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#2D3436', marginBottom: 12 }}>
              解答记录 ({logs.length})
            </Text>

            {logs.length === 0 && (
              <View style={{ backgroundColor: '#FFF', borderRadius: 16, padding: 40, alignItems: 'center' }}>
                <Feather name="inbox" size={48} color="#B2BEC3" />
                <Text style={{ color: '#B2BEC3', marginTop: 12, fontSize: 15 }}>暂无解答记录</Text>
                <Text style={{ color: '#B2BEC3', fontSize: 13, marginTop: 4 }}>在 Tutor 对话中点击「我明白了！」来记录</Text>
              </View>
            )}

            {logs.map((log) => (
              <TouchableOpacity
                key={log.id}
                style={{ backgroundColor: '#FFF', borderRadius: 16, padding: 16, marginBottom: 12 }}
                onPress={() => {
                  router.push('/ai-chat');
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#6C63FF1A', justifyContent: 'center', alignItems: 'center', marginRight: 12 }}>
                    <Feather name="help-circle" size={18} color="#6C63FF" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: '#2D3436', lineHeight: 22 }} numberOfLines={2}>
                      {log.question}
                    </Text>
                    <Text style={{ fontSize: 13, color: '#636E72', marginTop: 6 }} numberOfLines={2}>
                      {log.answer?.slice(0, 100)}...
                    </Text>
                    <Text style={{ fontSize: 12, color: '#B2BEC3', marginTop: 8 }}>
                      {new Date(log.created_at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={18} color="#B2BEC3" />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}
    </Screen>
  );
}
