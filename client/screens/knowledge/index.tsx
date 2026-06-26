import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Dimensions, ActivityIndicator, Modal, RefreshControl, Platform } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Feather, MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Rect as SvgRect, Text as SvgText, Line, Circle, G, Defs } from 'react-native-svg';

import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/utils/api';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SVG_WIDTH = 1200;
const SVG_HEIGHT = 900;

// Simple ErrorBoundary for graph SVG rendering
class GraphErrorBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }> {
  state = { hasError: false, error: '' };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

const COLORS = {
  bg: '#F0F0F3',
  text: '#2D3436',
  textSecondary: '#636E72',
  textMuted: '#B2BEC3',
  primary: '#6C63FF',
  orange: '#FF9F43',
  green: '#00B894',
};

interface TagNode {
  id: string;
  name: string;
  level: 'L1' | 'L2' | 'L3';
  count: number;
  documentIds: string[];
  parentId?: string;
  children: string[];
  x: number;
  y: number;
}

interface GraphEdge {
  from: string;
  to: string;
  type: 'hierarchy' | 'cooccurrence';
  weight?: number;
}

interface DomainCircle {
  name: string;
  cx: number;
  cy: number;
  r: number;
  count: number;
}

interface TagDocument {
  id: string;
  title: string;
  type: 'study_note' | 'material';
  papercore: string;
  tags: string[];
  logical_path: string;
  created_at: string;
}

interface GraphData {
  nodes: TagNode[];
  edges: GraphEdge[];
  domains: DomainCircle[];
  canvas: { width: number; height: number };
  totalRecords: number;
}

export default function KnowledgePage() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();

  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTag, setSelectedTag] = useState<TagNode | null>(null);
  const [tagDocuments, setTagDocuments] = useState<TagDocument[]>([]);
  const [loadingTagDocs, setLoadingTagDocs] = useState(false);
  const [viewMode, setViewMode] = useState<'graph' | 'folder'>('graph');

  // Graph interaction
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  const savedScale = useSharedValue(1);

  const [graphError, setGraphError] = useState<string | null>(null);
  // Folder view state
  const [allRecords, setAllRecords] = useState<any[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const fetchGraphData = useCallback(async () => {
    try {
      const res = await api.getGraphData();
      console.log('[knowledge-graph] Tag graph data:', JSON.stringify({
        tagNodes: res.data?.nodes?.length,
        edges: res.data?.edges?.length,
        domains: res.data?.domains?.length,
        totalRecords: res.data?.totalRecords,
        levels: res.data?.nodes?.reduce((acc: any, n: any) => { acc[n.level] = (acc[n.level]||0)+1; return acc; }, {}),
      }));
      if (res.data) {
        setGraphData(res.data);
        setGraphError(null);
      }
    } catch (err) {
      console.error('Failed to fetch graph data:', err);
      setGraphError(String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchGraphData();
    }, [fetchGraphData])
  );

  const onRefresh = () => {
    setRefreshing(true);
    if (viewMode === 'folder') {
      fetchRecordsForFolder();
    } else {
      fetchGraphData();
    }
  };

  // Fetch all records for folder view
  const fetchRecordsForFolder = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const res = await api.getRecentRecords();
      setAllRecords(res.data || []);
    } catch { setAllRecords([]); }
    finally { setLoadingRecords(false); setRefreshing(false); }
  }, []);

  // Build traditional folder tree from logical_path
  interface FolderDoc { id: string; title: string; type: 'study_note' | 'material'; papercore: string; logical_path: string; createdAt: string; }
  interface FolderNode { name: string; fullPath: string; subfolders: Map<string, FolderNode>; docs: FolderDoc[]; }

  const folderTree = useMemo(() => {
    const root = new Map<string, FolderNode>();
    allRecords.forEach((rec: any) => {
      const lp: string = rec.logical_path || '';
      const parts = lp.split('/').filter(Boolean);
      if (parts.length === 0) return;
      let current = root;
      let pathSoFar = '';
      parts.forEach((part, i) => {
        pathSoFar += '/' + part;
        if (!current.has(part)) {
          current.set(part, { name: part, fullPath: pathSoFar + '/', subfolders: new Map(), docs: [] });
        }
        const node = current.get(part)!;
        if (i === parts.length - 1) {
          node.docs.push({
            id: rec.id,
            title: rec.title || rec.name || '',
            type: rec.record_type || 'study_note',
            papercore: rec.papercore || '',
            logical_path: lp,
            createdAt: rec.created_at || '',
          });
        }
        current = node.subfolders;
      });
    });
    return root;
  }, [allRecords]);

  // Interactive graph gestures
  const pinchGesture = Gesture.Pinch()
    .onUpdate(e => {
      scale.value = Math.max(0.3, Math.min(savedScale.value * e.scale, 4));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
    });

  const panGesture = Gesture.Pan()
    .onUpdate(e => {
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const composedGesture = Gesture.Simultaneous(pinchGesture, panGesture);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  // Tag node map for efficient edge coordinate lookup
  const tagMap = useMemo(() => {
    if (!graphData?.nodes) return new Map<string, TagNode>();
    const map = new Map<string, TagNode>();
    graphData.nodes.forEach(n => map.set(n.id, n));
    return map;
  }, [graphData]);

  // Toggle folder expand/collapse
  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Count total items in a folder (recursive)
  const countFolder = (node: FolderNode): number => {
    let count = node.docs.length;
    node.subfolders.forEach(sub => { count += countFolder(sub); });
    return count;
  };

  // Render traditional folder tree
  const renderFolderTree = (folders: Map<string, FolderNode>, depth: number = 0) => {
    const sortedFolders = Array.from(folders.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return sortedFolders.map(([key, node]) => {
      const isExpanded = expandedFolders.has(node.fullPath);
      const totalCount = countFolder(node);
      const hasSubfolders = node.subfolders.size > 0;
      return (
        <View key={node.fullPath}>
          <TouchableOpacity
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 12,
              paddingLeft: 16 + depth * 24,
              paddingRight: 16,
              borderBottomWidth: 1,
              borderBottomColor: 'rgba(0,0,0,0.04)',
              gap: 8,
            }}
            onPress={() => toggleFolder(node.fullPath)}
          >
            <Feather
              name={isExpanded ? 'chevron-down' : 'chevron-right'}
              size={16}
              color={COLORS.textSecondary}
            />
            <Feather name={isExpanded ? 'folder' : 'folder'} size={18} color={isExpanded ? '#E67E22' : '#FF9F43'} />
            <Text style={{ flex: 1, fontSize: 15, color: COLORS.text, fontWeight: '500' }} numberOfLines={1}>
              {node.name}
            </Text>
            <Text style={{ fontSize: 12, color: COLORS.textSecondary }}>{totalCount}</Text>
          </TouchableOpacity>
          {isExpanded && (
            <View>
              {/* Subfolders first */}
              {hasSubfolders && renderFolderTree(node.subfolders, depth + 1)}
              {/* Documents in this folder */}
              {node.docs.map((doc, i) => (
                <TouchableOpacity
                  key={doc.id || `d${i}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 10,
                    paddingLeft: 64 + depth * 24,
                    paddingRight: 16,
                    borderBottomWidth: 1,
                    borderBottomColor: 'rgba(0,0,0,0.03)',
                    gap: 8,
                  }}
                  onPress={() => {
                    const route = doc.type === 'study_note' ? '/study-note-edit' : '/material-edit';
                    router.push(route, { id: doc.id });
                  }}
                >
                  <Feather
                    name={doc.type === 'study_note' ? 'edit-3' : 'file-text'}
                    size={14}
                    color={doc.type === 'study_note' ? COLORS.primary : COLORS.orange}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: COLORS.text, fontWeight: '500' }} numberOfLines={1}>
                      {doc.title}
                    </Text>
                    {doc.papercore ? (
                      <Text style={{ fontSize: 10, color: COLORS.textMuted, marginTop: 1 }} numberOfLines={1}>
                        {doc.papercore}
                      </Text>
                    ) : null}
                  </View>
                  <Feather name="chevron-right" size={12} color={COLORS.textMuted} />
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      );
    });
  };

  // Edge color by type
  // Edge styling by type
  const edgeStyle = (type: string, weight?: number) => {
    if (type === 'hierarchy') {
      return { color: '#6C63FF', width: 2.5, dash: undefined, opacity: 0.7 };
    }
    const w = Math.min((weight || 1) * 0.8 + 0.5, 3);
    return { color: '#74B9FF', width: w, dash: '4,3', opacity: 0.45 + Math.min((weight || 1) * 0.05, 0.3) };
  };

  // Handle tag node selection → fetch its documents
  const handleSelectTag = async (tag: TagNode) => {
    setSelectedTag(tag);
    setLoadingTagDocs(true);
    try {
      const res = await api.getTagDocuments(tag.name);
      setTagDocuments(res.data || []);
    } catch { setTagDocuments([]); }
    finally { setLoadingTagDocs(false); }
  };

  // Fallback card-based node rendering (used when SVG fails)
  const renderFallbackCards = () => {
    if (!graphData) return null;
    const leafNodes = graphData.nodes.filter(n => n.level === 'L3');
    return (
      <>
        <View style={{
          backgroundColor: '#FFF3E0',
          borderRadius: 12,
          padding: 12,
          marginBottom: 12,
          borderLeftWidth: 4,
          borderLeftColor: COLORS.orange,
        }}>
          <Text style={{ fontSize: 13, color: '#E65100', fontWeight: '600' }}>
            图形渲染暂不可用 — 以卡片形式展示 ({graphData.nodes.length} 个标签)
          </Text>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {graphData.nodes.map((node) => {
            const levelColors = { L1: COLORS.primary, L2: '#A29BFE', L3: '#DFE6E9' };
            const levelSizes = { L1: 20, L2: 16, L3: 12 };
            return (
              <TouchableOpacity
                key={node.id}
                style={{
                  width: (SCREEN_WIDTH - 52) / 2,
                  backgroundColor: COLORS.bg,
                  borderRadius: 16,
                  padding: 14,
                  borderLeftWidth: 3,
                  borderLeftColor: levelColors[node.level] || COLORS.primary,
                }}
                onPress={() => handleSelectTag(node)}
              >
                <Text style={{ fontSize: 13, fontWeight: '700', color: COLORS.text }} numberOfLines={2}>
                  {node.name}
                </Text>
                <Text style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4 }}>
                  {node.level} · {node.count} 条记录
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </>
    );
  };

  return (
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
      {/* Header */}
      <View style={{ paddingTop: insets.top + 16, paddingHorizontal: 20, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View>
            <Text style={{ fontSize: 28, fontWeight: '800', color: COLORS.text }}>知识库</Text>
            <Text style={{ fontSize: 14, color: COLORS.textSecondary, marginTop: 4 }}>
              {graphData ? `${graphData.nodes.length} 个标签 · ${graphData.totalRecords} 条记录` : '加载中...'}
            </Text>
          </View>
        </View>
      </View>

      {/* View Mode Toggle */}
      <View style={{
        flexDirection: 'row',
        margin: 16,
        backgroundColor: '#E8E8EB',
        borderRadius: 12,
        padding: 4,
      }}>
        <TouchableOpacity
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 10,
            borderRadius: 10,
            gap: 6,
            backgroundColor: viewMode === 'graph' ? COLORS.primary : 'transparent',
          }}
          onPress={() => setViewMode('graph')}
        >
          <MaterialIcons name="account-tree" size={18} color={viewMode === 'graph' ? '#fff' : COLORS.textSecondary} />
          <Text style={{
            fontSize: 14,
            fontWeight: '600',
            color: viewMode === 'graph' ? '#fff' : COLORS.textSecondary,
          }}>图谱模式</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            paddingVertical: 10,
            borderRadius: 10,
            gap: 6,
            backgroundColor: viewMode === 'folder' ? COLORS.primary : 'transparent',
          }}
          onPress={() => { setViewMode('folder'); fetchRecordsForFolder(); }}
        >
          <Feather name="folder" size={18} color={viewMode === 'folder' ? '#fff' : COLORS.textSecondary} />
          <Text style={{
            fontSize: 14,
            fontWeight: '600',
            color: viewMode === 'folder' ? '#fff' : COLORS.textSecondary,
          }}>文件夹</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <View style={{ padding: 48, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={COLORS.primary} />
          </View>
        ) : graphError ? (
          <View style={{ padding: 48, alignItems: 'center' }}>
            <Feather name="alert-triangle" size={48} color="#E17055" />
            <Text style={{ marginTop: 12, fontSize: 16, color: '#E17055', fontWeight: '600' }}>图谱数据加载失败</Text>
            <Text style={{ marginTop: 4, fontSize: 13, color: COLORS.textMuted, textAlign: 'center' }}>{graphError}</Text>
            <TouchableOpacity
              style={{ marginTop: 16, backgroundColor: COLORS.primary, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 12 }}
              onPress={() => { setLoading(true); setGraphError(null); fetchGraphData(); }}
            >
              <Text style={{ color: '#FFF', fontWeight: '600' }}>重试</Text>
            </TouchableOpacity>
          </View>
        ) : !graphData || graphData.nodes.length === 0 ? (
          <View style={{ padding: 48, alignItems: 'center' }}>
            <Feather name="folder-open" size={64} color="#ddd" />
            <Text style={{ marginTop: 12, fontSize: 16, color: '#999' }}>暂无知识记录</Text>
            <Text style={{ marginTop: 4, fontSize: 13, color: COLORS.textMuted }}>
              创建学习纪要或上传资料将自动构建知识图谱
            </Text>
          </View>
        ) : viewMode === 'graph' ? (
          <>
            {/* Legend */}
            <View style={{
              backgroundColor: COLORS.bg,
              borderRadius: 20,
              padding: 16,
              marginBottom: 16,
              shadowColor: '#D1D9E6',
              shadowOffset: { width: 4, height: 4 },
              shadowOpacity: 0.6,
              shadowRadius: 6,
              elevation: 4,
            }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: COLORS.text, marginBottom: 12 }}>图例</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: COLORS.primary }} />
                  <Text style={{ fontSize: 12, color: COLORS.textSecondary }}>L1 领域</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#A29BFE' }} />
                  <Text style={{ fontSize: 12, color: COLORS.textSecondary }}>L2 模块</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#DFE6E9' }} />
                  <Text style={{ fontSize: 12, color: COLORS.textSecondary }}>L3 知识点</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 24, height: 2, backgroundColor: '#6C63FF', borderRadius: 1 }} />
                  <Text style={{ fontSize: 12, color: COLORS.textSecondary }}>层级关系</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 24, height: 1, borderWidth: 1, borderStyle: 'dashed', borderColor: '#74B9FF' }} />
                  <Text style={{ fontSize: 12, color: COLORS.textSecondary }}>标签共现</Text>
                </View>
              </View>
            </View>

            {/* SVG Graph (wrapped in ErrorBoundary) */}
            <GraphErrorBoundary fallback={renderFallbackCards()}>
            <View style={{
              backgroundColor: '#FAFBFC',
              borderRadius: 20,
              padding: 8,
              marginBottom: 16,
              minHeight: 400,
              shadowColor: '#D1D9E6',
              shadowOffset: { width: 4, height: 4 },
              shadowOpacity: 0.6,
              shadowRadius: 6,
              elevation: 4,
              overflow: 'hidden',
            }}>
              <GestureDetector gesture={composedGesture}>
                <Animated.View style={[animatedStyle]}>
                  <Svg width={SVG_WIDTH} height={SVG_HEIGHT} viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}>
                    {/* Domain circles */}
                    {graphData.domains.map((domain, i) => {
                      if (domain.cx == null || domain.cy == null || domain.r == null) return null;
                      return (
                        <G key={`domain-${i}`}>
                          <Circle
                            cx={domain.cx}
                            cy={domain.cy}
                            r={domain.r}
                            fill="#6C63FF"
                            opacity={0.04}
                            stroke="#6C63FF"
                            strokeWidth={0.5}
                            strokeOpacity={0.15}
                          />
                          <SvgText
                            x={domain.cx}
                            y={domain.cy - domain.r + 20}
                            textAnchor="middle"
                            fontSize={13}
                            fill="#6C63FF"
                            fontWeight="600"
                            opacity={0.5}
                          >
                            {domain.name}
                          </SvgText>
                        </G>
                      );
                    })}

                    {/* Edges */}
                    {graphData.edges.map((edge, i) => {
                      const fromNode = tagMap.get(edge.from);
                      const toNode = tagMap.get(edge.to);
                      if (!fromNode || !toNode) return null;
                      if (fromNode.x == null || fromNode.y == null || toNode.x == null || toNode.y == null) return null;
                      const es = edgeStyle(edge.type, edge.weight);
                      return (
                        <Line
                          key={`edge-${i}`}
                          x1={fromNode.x}
                          y1={fromNode.y}
                          x2={toNode.x}
                          y2={toNode.y}
                          stroke={es.color}
                          strokeWidth={es.width}
                          strokeDasharray={es.dash}
                          opacity={es.opacity}
                        />
                      );
                    })}

                    {/* Tag Nodes — circles sized by level */}
                    {graphData.nodes.map((node) => {
                      if (node.x == null || node.y == null) return null;
                      const levelColors = { L1: COLORS.primary, L2: '#A29BFE', L3: '#DFE6E9' };
                      const levelRadii = { L1: 28, L2: 18, L3: 12 };
                      const fontSizes = { L1: 13, L2: 11, L3: 9 };
                      const r = levelRadii[node.level] || 14;
                      const fill = levelColors[node.level] || COLORS.primary;
                      const isL3 = node.level === 'L3';

                      return (
                        <G key={node.id} onPress={() => handleSelectTag(node)}>
                          <Circle
                            cx={node.x}
                            cy={node.y}
                            r={r}
                            fill={isL3 ? '#FFFFFF' : fill}
                            stroke={fill}
                            strokeWidth={isL3 ? 1.5 : 2}
                            opacity={isL3 ? 0.95 : 0.9}
                          />
                          <SvgText
                            x={node.x}
                            y={node.y + (fontSizes[node.level] || 10) / 3}
                            textAnchor="middle"
                            fontSize={fontSizes[node.level] || 10}
                            fill={isL3 ? COLORS.textSecondary : '#FFFFFF'}
                            fontWeight={node.level === 'L1' ? '700' : '600'}
                          >
                            {node.name.length > 4 ? node.name.slice(0, 4) : node.name}
                          </SvgText>
                          {/* Count badge for L1/L2 */}
                          {!isL3 && (
                            <SvgText
                              x={node.x}
                              y={node.y + r + 14}
                              textAnchor="middle"
                              fontSize={10}
                              fill={COLORS.textSecondary}
                            >
                              {node.count}项
                            </SvgText>
                          )}
                        </G>
                      );
                    })}
                  </Svg>
                </Animated.View>
              </GestureDetector>
              <Text style={{ textAlign: 'center', fontSize: 11, color: COLORS.textMuted, marginTop: 8, paddingBottom: 4 }}>
                单指拖拽 · 双指缩放 · 点击节点查看详情
              </Text>
            </View>
            </GraphErrorBoundary>

            {/* Stats */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{
                flex: 1,
                backgroundColor: COLORS.bg,
                borderRadius: 20,
                padding: 16,
                alignItems: 'center',
                shadowColor: '#D1D9E6',
                shadowOffset: { width: 4, height: 4 },
                shadowOpacity: 0.6,
                shadowRadius: 6,
                elevation: 4,
              }}>
                <Text style={{ fontSize: 28, fontWeight: '800', color: COLORS.primary }}>
                  {graphData.nodes.filter(n => n.level === 'L1').length}
                </Text>
                <Text style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 4 }}>L1 领域</Text>
              </View>
              <View style={{
                flex: 1,
                backgroundColor: COLORS.bg,
                borderRadius: 20,
                padding: 16,
                alignItems: 'center',
                shadowColor: '#D1D9E6',
                shadowOffset: { width: 4, height: 4 },
                shadowOpacity: 0.6,
                shadowRadius: 6,
                elevation: 4,
              }}>
                <Text style={{ fontSize: 28, fontWeight: '800', color: COLORS.green }}>
                  {graphData.nodes.length}
                </Text>
                <Text style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 4 }}>标签</Text>
              </View>
              <View style={{
                flex: 1,
                backgroundColor: COLORS.bg,
                borderRadius: 20,
                padding: 16,
                alignItems: 'center',
                shadowColor: '#D1D9E6',
                shadowOffset: { width: 4, height: 4 },
                shadowOpacity: 0.6,
                shadowRadius: 6,
                elevation: 4,
              }}>
                <Text style={{ fontSize: 28, fontWeight: '800', color: COLORS.orange }}>
                  {graphData.edges.length}
                </Text>
                <Text style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: 4 }}>关系</Text>
              </View>
            </View>
          </>
        ) : (
          <>
            {/* Traditional Folder View */}
            {loadingRecords ? (
              <View style={{ padding: 48, alignItems: 'center' }}>
                <ActivityIndicator size="large" color={COLORS.primary} />
              </View>
            ) : (
              <View style={{
                backgroundColor: COLORS.bg,
                borderRadius: 20,
                padding: 4,
                shadowColor: '#D1D9E6',
                shadowOffset: { width: 4, height: 4 },
                shadowOpacity: 0.6,
                shadowRadius: 6,
                elevation: 4,
              }}>
                {folderTree.size === 0 ? (
                  <View style={{ alignItems: 'center', padding: 32 }}>
                    <Feather name="folder" size={48} color="#ddd" />
                    <Text style={{ fontSize: 16, color: '#999', marginTop: 12 }}>暂无文件夹</Text>
                    <Text style={{ fontSize: 13, color: COLORS.textMuted, marginTop: 4 }}>
                      创建学习纪要或上传资料后将自动组织文件夹
                    </Text>
                  </View>
                ) : (
                  <View>
                    {/* Header */}
                    <View style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                      borderBottomWidth: 1,
                      borderBottomColor: 'rgba(0,0,0,0.05)',
                      gap: 8,
                    }}>
                      <Feather name="folder" size={16} color="#FF9F43" />
                      <Text style={{ fontSize: 14, fontWeight: '700', color: COLORS.text }}>
                        {allRecords.length} 条记录
                      </Text>
                    </View>
                    {renderFolderTree(folderTree)}
                  </View>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {/* Tag Detail BottomSheet */}
      <Modal visible={!!selectedTag} animationType="slide" transparent>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: COLORS.bg,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            maxHeight: '80%',
            shadowColor: COLORS.primary,
            shadowOffset: { width: 0, height: -4 },
            shadowOpacity: 0.2,
            shadowRadius: 16,
            elevation: 8,
          }}>
            {/* Handle bar */}
            <View style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 8 }}>
              <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: COLORS.textMuted }} />
            </View>

            <View style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingHorizontal: 20,
              paddingBottom: 12,
              borderBottomWidth: 1,
              borderBottomColor: 'rgba(0,0,0,0.05)',
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{
                  width: 16, height: 16, borderRadius: 8,
                  backgroundColor: selectedTag?.level === 'L1' ? COLORS.primary :
                                   selectedTag?.level === 'L2' ? '#A29BFE' : '#DFE6E9',
                }} />
                <Text style={{ fontSize: 18, fontWeight: '700', color: COLORS.text }}>
                  {selectedTag?.name}
                </Text>
                <View style={{
                  backgroundColor: COLORS.primary + '1A',
                  paddingHorizontal: 8,
                  paddingVertical: 2,
                  borderRadius: 8,
                }}>
                  <Text style={{ fontSize: 12, color: COLORS.primary, fontWeight: '600' }}>
                    {selectedTag?.level}
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => { setSelectedTag(null); setTagDocuments([]); }}>
                <Feather name="x" size={24} color={COLORS.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Tag info */}
            {selectedTag && (
              <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
                <Text style={{ fontSize: 13, color: COLORS.textSecondary }}>
                  共 {selectedTag.count} 条关联记录
                </Text>
              </View>
            )}

            {/* Document list */}
            <ScrollView style={{ paddingHorizontal: 20, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
              {loadingTagDocs ? (
                <View style={{ padding: 32, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={COLORS.primary} />
                </View>
              ) : tagDocuments.length === 0 ? (
                <View style={{ padding: 24, alignItems: 'center' }}>
                  <Text style={{ color: COLORS.textMuted }}>暂无关联文档</Text>
                </View>
              ) : (
                tagDocuments.map((doc, i) => (
                  <TouchableOpacity
                    key={doc.id || i}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 14,
                      paddingHorizontal: 4,
                      borderBottomWidth: 1,
                      borderBottomColor: 'rgba(0,0,0,0.04)',
                      gap: 10,
                    }}
                    onPress={() => {
                      setSelectedTag(null);
                      setTagDocuments([]);
                      const route = doc.type === 'study_note' ? '/study-note-edit' : '/material-edit';
                      router.push(route, { id: doc.id });
                    }}
                  >
                    <Feather
                      name={doc.type === 'study_note' ? 'edit-3' : 'file-text'}
                      size={18}
                      color={doc.type === 'study_note' ? COLORS.primary : COLORS.orange}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: COLORS.text }} numberOfLines={1}>
                        {doc.title}
                      </Text>
                      <Text style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }} numberOfLines={1}>
                        {doc.logical_path || ''}
                      </Text>
                    </View>
                    <Feather name="chevron-right" size={14} color={COLORS.textMuted} />
                  </TouchableOpacity>
                ))
              )}
              <View style={{ height: 32 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
