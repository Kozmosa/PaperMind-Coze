import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Dimensions,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
} from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Feather, AntDesign } from '@expo/vector-icons';
import { LineChart } from 'react-native-chart-kit';
import { Screen } from '@/components/layout/Screen';
import { api } from '@/utils/api';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useCSSVariable } from 'uniwind';

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
  const [backgroundSecondary, border] = useCSSVariable([
    '--color-background-secondary',
    '--color-border',
  ]) as string[];
  const bgSecondary = backgroundSecondary || '#E7E7EC';
  const borderColor = border || '#E3DED9';
  const [logs, setLogs] = useState<ProblemLog[]>([]);
  const [dailyCounts, setDailyCounts] = useState<DailyCount[]>([]);
  const [statsTotal, setStatsTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [recordModal, setRecordModal] = useState(false);
  const [problemText, setProblemText] = useState('');
  const [processText, setProcessText] = useState('');
  const [solutionText, setSolutionText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 手动录入问题解决记录（feed paper_problem_logs，反思数据源 #1）
  const handleSubmitProblemLog = async () => {
    if (!problemText.trim()) {
      Alert.alert('提示', '请填写问题描述');
      return;
    }
    setSubmitting(true);
    try {
      await api.createProblemLog({
        problem: problemText.trim(),
        process: processText.trim() || null,
        solution: solutionText.trim() || null,
      });
      Alert.alert('已记录', '问题解决记录已保存，将参与后续反思报告');
      setProblemText('');
      setProcessText('');
      setSolutionText('');
      setRecordModal(false);
    } catch (e: any) {
      Alert.alert('保存失败', e.message || '请重试');
    } finally {
      setSubmitting(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, []),
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
      // 总数与折线图/活跃天数统一为近 30 天窗口
      setStatsTotal(statsRes.data?.total || 0);
    } catch (e) {
      console.error('Failed to load data', e);
    } finally {
      setLoading(false);
    }
  };

  const totalCount = statsTotal;

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'top']}>
      {/* Header */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          backgroundColor: '#FFF',
          borderBottomWidth: 1,
          borderBottomColor: borderColor,
        }}
      >
        <TouchableOpacity onPress={() => router.back()}>
          <Feather name="arrow-left" size={24} color="#2D3436" />
        </TouchableOpacity>
        <Text
          style={{ marginLeft: 12, fontSize: 18, fontWeight: '700', color: '#2D3436', flex: 1 }}
        >
          问题解答日志
        </Text>
        <TouchableOpacity
          onPress={() => setRecordModal(true)}
          style={{
            backgroundColor: '#6C63FF1A',
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 20,
          }}
        >
          <Text style={{ color: '#6C63FF', fontSize: 13, fontWeight: '600' }}>＋ 记录问题</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="#6C63FF" />
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          {/* Summary stats */}
          <View style={{ padding: 16 }}>
            <View
              style={{ backgroundColor: '#FFF', borderRadius: 16, padding: 20, marginBottom: 16 }}
            >
              <Text style={{ fontSize: 16, fontWeight: '700', color: '#2D3436', marginBottom: 16 }}>
                <AntDesign name="pie-chart" size={16} color="#2D3436" /> 学习数据
              </Text>

              <View style={{ flexDirection: 'row', marginBottom: 20 }}>
                <View
                  style={{
                    flex: 1,
                    backgroundColor: bgSecondary,
                    borderRadius: 12,
                    padding: 16,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 32, fontWeight: '800', color: '#6C63FF' }}>
                    {totalCount}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#636E72', marginTop: 4 }}>近30天解决</Text>
                </View>
                <View style={{ width: 12 }} />
                <View
                  style={{
                    flex: 1,
                    backgroundColor: bgSecondary,
                    borderRadius: 12,
                    padding: 16,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ fontSize: 32, fontWeight: '800', color: '#00B894' }}>
                    {dailyCounts.length > 0 ? dailyCounts.length : 0}
                  </Text>
                  <Text style={{ fontSize: 13, color: '#636E72', marginTop: 4 }}>
                    活跃天数（近30天）
                  </Text>
                </View>
              </View>

              {/* Line chart */}
              {dailyCounts.length > 0 && (
                <View style={{ backgroundColor: '#F8F9FA', borderRadius: 12, padding: 16 }}>
                  <Text
                    style={{ fontSize: 14, fontWeight: '600', color: '#2D3436', marginBottom: 12 }}
                  >
                    解决问题数量趋势
                  </Text>
                  <LineChart
                    data={{
                      labels: dailyCounts.map((d) => d.date.slice(5)),
                      datasets: [
                        {
                          data: dailyCounts.map((d) => d.count),
                          color: (opacity = 1) => `rgba(108, 99, 255, ${opacity})`,
                          strokeWidth: 2,
                        },
                      ],
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
                      decimalPlaces: 0,
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
              <View
                style={{
                  backgroundColor: '#FFF',
                  borderRadius: 16,
                  padding: 40,
                  alignItems: 'center',
                }}
              >
                <Feather name="inbox" size={48} color="#B2BEC3" />
                <Text style={{ color: '#B2BEC3', marginTop: 12, fontSize: 15 }}>暂无解答记录</Text>
                <Text style={{ color: '#B2BEC3', fontSize: 13, marginTop: 4 }}>
                  在 Tutor 对话中点击「我明白了！」来记录
                </Text>
              </View>
            )}

            {logs.map((log) => (
              <TouchableOpacity
                key={log.id}
                style={{ backgroundColor: '#FFF', borderRadius: 16, padding: 16, marginBottom: 12 }}
                onPress={() => {
                  // 回跳完整 Tutor 对话页（主 Tab），不再进入无引用卡片的 /ai-chat 降级页
                  router.push('/');
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 18,
                      backgroundColor: '#6C63FF1A',
                      justifyContent: 'center',
                      alignItems: 'center',
                      marginRight: 12,
                    }}
                  >
                    <Feather name="help-circle" size={18} color="#6C63FF" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ fontSize: 15, fontWeight: '600', color: '#2D3436', lineHeight: 22 }}
                      numberOfLines={2}
                    >
                      {log.question}
                    </Text>
                    <Text
                      style={{ fontSize: 13, color: '#636E72', marginTop: 6 }}
                      numberOfLines={2}
                    >
                      {log.answer?.slice(0, 100)}...
                    </Text>
                    <Text style={{ fontSize: 12, color: '#B2BEC3', marginTop: 8 }}>
                      {new Date(log.created_at).toLocaleDateString('zh-CN', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={18} color="#B2BEC3" />
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}

      {/* 问题解决记录录入弹窗 */}
      <Modal
        visible={recordModal}
        transparent
        animationType="slide"
        onRequestClose={() => setRecordModal(false)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' }}>
          <View
            style={{
              backgroundColor: '#FFF',
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              padding: 20,
              paddingBottom: 32,
            }}
          >
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436', marginBottom: 16 }}>
              记录问题解决
            </Text>
            <Text style={{ fontSize: 13, color: '#636E72', marginBottom: 6 }}>问题描述 *</Text>
            <TextInput
              style={{
                backgroundColor: bgSecondary,
                borderRadius: 12,
                padding: 12,
                fontSize: 14,
                color: '#2D3436',
                marginBottom: 12,
              }}
              placeholder="遇到了什么问题？"
              placeholderTextColor="#B2BEC3"
              value={problemText}
              onChangeText={setProblemText}
              multiline
            />
            <Text style={{ fontSize: 13, color: '#636E72', marginBottom: 6 }}>
              解决过程（可选）
            </Text>
            <TextInput
              style={{
                backgroundColor: bgSecondary,
                borderRadius: 12,
                padding: 12,
                fontSize: 14,
                color: '#2D3436',
                marginBottom: 12,
              }}
              placeholder="你是怎么一步步解决的？"
              placeholderTextColor="#B2BEC3"
              value={processText}
              onChangeText={setProcessText}
              multiline
            />
            <Text style={{ fontSize: 13, color: '#636E72', marginBottom: 6 }}>
              解决方案（可选）
            </Text>
            <TextInput
              style={{
                backgroundColor: bgSecondary,
                borderRadius: 12,
                padding: 12,
                fontSize: 14,
                color: '#2D3436',
                marginBottom: 20,
              }}
              placeholder="最终方案 / 结论"
              placeholderTextColor="#B2BEC3"
              value={solutionText}
              onChangeText={setSolutionText}
              multiline
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity
                onPress={() => setRecordModal(false)}
                style={{
                  flex: 1,
                  backgroundColor: bgSecondary,
                  borderRadius: 14,
                  paddingVertical: 12,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#636E72', fontWeight: '600' }}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSubmitProblemLog}
                disabled={submitting}
                style={{
                  flex: 1,
                  backgroundColor: '#6C63FF',
                  borderRadius: 14,
                  paddingVertical: 12,
                  alignItems: 'center',
                }}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <Text style={{ color: '#FFF', fontWeight: '700' }}>保存</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
