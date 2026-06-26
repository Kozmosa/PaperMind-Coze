import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Feather, AntDesign } from '@expo/vector-icons';
import { Screen } from '@/components/Screen';
import { api } from '@/utils/api';
import { useSafeRouter } from '@/hooks/useSafeRouter';

type Reflection = {
  id: number;
  period: string;
  learning_behavior: string;
  challenge_report: string;
  thinking_pattern: string;
  suggestion: string;
  created_at: string;
};

const TIME_OPTIONS = [
  { label: '近三天', value: '3days' },
  { label: '近一周', value: '7days' },
  { label: '近一个月', value: '30days' },
];

export default function ReflectionIndexScreen() {
  const router = useSafeRouter();
  const [reflections, setReflections] = useState<Reflection[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState('7days');

  useFocusEffect(
    useCallback(() => {
      loadReflections();
    }, [])
  );

  const loadReflections = async () => {
    setLoading(true);
    try {
      const res = await api.getReflections();
      setReflections(res.data || []);
    } catch (e) {
      console.error('Failed to load reflections', e);
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateReport = async () => {
    setGenerating(true);
    try {
      await api.createReflection({ period: selectedPeriod });
      await loadReflections();
    } catch (e) {
      console.error('Failed to generate report', e);
    } finally {
      setGenerating(false);
    }
  };

  const getPeriodLabel = (period: string) => {
    const option = TIME_OPTIONS.find((o) => o.value === period);
    return option?.label || period;
  };

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'top']}>
      {/* Header */}
      <View style={{ paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#FFF', borderBottomWidth: 1, borderBottomColor: '#F0F0F3' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity onPress={() => router.back()}>
            <Feather name="arrow-left" size={24} color="#2D3436" />
          </TouchableOpacity>
          <Text style={{ marginLeft: 12, fontSize: 18, fontWeight: '700', color: '#2D3436' }}>学习反思</Text>
        </View>
      </View>

      {loading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color="#6C63FF" />
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false}>
          {/* Report generation card */}
          <View style={{ backgroundColor: '#FFF', borderRadius: 20, padding: 24, marginBottom: 24, shadowColor: '#D1D9E6', shadowOffset: { width: 4, height: 4 }, shadowOpacity: 0.6, shadowRadius: 8, elevation: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#6C63FF18', justifyContent: 'center', alignItems: 'center', marginRight: 12 }}>
                <Feather name="bar-chart-2" size={22} color="#6C63FF" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#2D3436' }}>生成学习报告</Text>
                <Text style={{ fontSize: 13, color: '#636E72', marginTop: 2 }}>小助手正在撰写学习报告请稍后</Text>
              </View>
            </View>

            <Text style={{ fontSize: 14, fontWeight: '600', color: '#2D3436', marginBottom: 12 }}>选择时间段</Text>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
              {TIME_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={{
                    flex: 1,
                    paddingVertical: 10,
                    borderRadius: 12,
                    backgroundColor: selectedPeriod === opt.value ? '#6C63FF' : '#F0F0F3',
                    alignItems: 'center',
                  }}
                  onPress={() => setSelectedPeriod(opt.value)}
                >
                  <Text style={{ color: selectedPeriod === opt.value ? '#FFF' : '#636E72', fontWeight: '600', fontSize: 14 }}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              style={{
                backgroundColor: generating ? '#B2BEC3' : '#6C63FF',
                borderRadius: 14,
                paddingVertical: 14,
                alignItems: 'center',
              }}
              onPress={handleGenerateReport}
              disabled={generating}
            >
              {generating ? (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <ActivityIndicator size="small" color="#FFF" />
                  <Text style={{ color: '#FFF', fontWeight: '700', marginLeft: 8 }}>生成中，请稍后...</Text>
                </View>
              ) : (
                <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 15 }}>开始生成报告</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* History reports */}
          <Text style={{ fontSize: 16, fontWeight: '700', color: '#2D3436', marginBottom: 12 }}>
            历史报告 ({reflections.length})
          </Text>

          {reflections.length === 0 && (
            <View style={{ backgroundColor: '#FFF', borderRadius: 20, padding: 40, alignItems: 'center' }}>
              <Feather name="inbox" size={48} color="#B2BEC3" />
              <Text style={{ color: '#B2BEC3', marginTop: 12, fontSize: 15 }}>暂无报告</Text>
              <Text style={{ color: '#B2BEC3', fontSize: 13, marginTop: 4, textAlign: 'center' }}>选择时间段后点击「开始生成报告」</Text>
            </View>
          )}

          {reflections.map((r) => (
            <TouchableOpacity
              key={r.id}
              style={{ backgroundColor: '#FFF', borderRadius: 16, padding: 16, marginBottom: 12 }}
              onPress={() => router.push('/reflection-detail', { id: r.id })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#6C63FF18', justifyContent: 'center', alignItems: 'center', marginRight: 12 }}>
                  <Feather name="file-text" size={20} color="#6C63FF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: '#2D3436' }}>学习反思报告</Text>
                  <Text style={{ fontSize: 12, color: '#636E72', marginTop: 2 }}>
                    {getPeriodLabel(r.period)} · {new Date(r.created_at).toLocaleDateString()}
                  </Text>
                </View>
                <Feather name="chevron-right" size={18} color="#B2BEC3" />
              </View>

              {/* Preview snippets */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {r.learning_behavior && (
                  <View style={{ backgroundColor: '#F0F0F3', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text style={{ fontSize: 12, color: '#636E72' }} numberOfLines={1}>
                      <AntDesign name="pie-chart" size={12} color="#636E72" /> {r.learning_behavior.slice(0, 20)}...
                    </Text>
                  </View>
                )}
                {r.challenge_report && (
                  <View style={{ backgroundColor: '#F0F0F3', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 }}>
                    <Text style={{ fontSize: 12, color: '#636E72' }} numberOfLines={1}>
                      <AntDesign name="check-circle" size={12} color="#636E72" /> {r.challenge_report.slice(0, 20)}...
                    </Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
