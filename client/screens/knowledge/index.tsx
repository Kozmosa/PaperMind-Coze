import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Modal, RefreshControl, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Feather, MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, runOnJS } from 'react-native-reanimated';
import Svg, { Text as SvgText, Line, Circle, G } from 'react-native-svg';

import { Screen } from '@/components/layout/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/utils/api';
import NoteHelperPanel from '@/components/note-helper/NoteHelperPanel';
import type { Citation } from '@/components/note-helper/NoteHelperPanel';

const CANVAS = { w: 1200, h: 900 };

// Neumorphic color palette
const C = {
  bg: '#EEF0F5',
  surface: '#F7F8FC',
  card: '#FFFFFF',
  primary: '#5B5FEF',
  primaryLight: '#8B8FF5',
  accent: '#FF6B6B',
  accent2: '#4ECDC4',
  accent3: '#FFD93D',
  text: '#1E1E2E',
  text2: '#6B7280',
  text3: '#A0A5B5',
  border: '#E8EAF0',
  shadow: '#C8CCD8',
  shadowDark: '#A0A5B5',
};

// L2 cluster colors for visual grouping
const L2_CLUSTER_COLORS = [
  '#EEF2FF', // indigo
  '#FEF3C7', // amber
  '#ECFDF5', // green
  '#FCE7F3', // pink
  '#E0F2FE', // sky
  '#F3E8FF', // purple
  '#FFF1F2', // rose
  '#F0FDF4', // emerald
];

const NODE_STYLE = {
  L1: { r: 28, fill: C.primary, stroke: C.primaryLight, strokeW: 3, fontSize: 14, fontColor: '#FFFFFF' },
  L2: { r: 20, fill: '#FFFFFF', stroke: C.primaryLight, strokeW: 2.5, fontSize: 11, fontColor: C.text },
  L3: { r: 13, fill: '#FFFFFF', stroke: '#C4C8D8', strokeW: 1.5, fontSize: 9, fontColor: C.text2 },
};

interface TagNode {
  id: string; name: string; level: 'L1' | 'L2' | 'L3';
  count: number; documentIds: string[]; parentId?: string; children: string[];
  x: number; y: number;
}
interface GraphEdge { from: string; to: string; type: 'hierarchy' | 'cooccurrence'; weight?: number; }
interface DomainCircle { name: string; cx: number; cy: number; r: number; count: number; }
interface TagDocument { id: string; title: string; type: 'study_note' | 'material'; papercore: string; tags: string[]; logical_path: string; created_at: string; }
interface GraphData { nodes: TagNode[]; edges: GraphEdge[]; domains: DomainCircle[]; canvas: { width: number; height: number }; totalRecords: number; }

class GraphErrorBoundary extends React.Component<{ children: React.ReactNode; fallback: React.ReactNode }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

export default function KnowledgePage() {
  const router = useSafeRouter();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();

  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTag, setSelectedTag] = useState<TagNode | null>(null);
  const [tagDocuments, setTagDocuments] = useState<TagDocument[]>([]);
  const [loadingTagDocs, setLoadingTagDocs] = useState(false);
  const [viewMode, setViewMode] = useState<'graph' | 'folder'>('graph');
  const [showLegend, setShowLegend] = useState(false);

  // Graph interaction state
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const scale = useSharedValue(1);
  const savedTX = useSharedValue(0);
  const savedTY = useSharedValue(0);
  const savedScale = useSharedValue(1);

  // Auto-fit initial view
  const [initialFit, setInitialFit] = useState(false);

  const [graphError, setGraphError] = useState<string | null>(null);
  const [allRecords, setAllRecords] = useState<any[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [noteHelperVisible, setNoteHelperVisible] = useState(false);
  const [noteHelperSourceFiles, setNoteHelperSourceFiles] = useState<Array<{ id: string; type: 'study_note' | 'material'; title: string; logicalPath?: string }>>([]);

  const enterSelectMode = (doc: any) => { setSelectMode(true); setSelectedIds(new Set([`${doc.type || doc.record_type}_${doc.id}`])); };
  const toggleSelect = (doc: any) => {
    const key = `${doc.type || doc.record_type}_${doc.id}`;
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      if (next.size === 0) setSelectMode(false);
      return next;
    });
  };

  const handleGenerateNote = () => {
    setNoteHelperSourceFiles(
      allRecords.filter(r => selectedIds.has(`${r.record_type}_${r.id}`)).map(r => ({
        id: r.id, type: r.record_type as 'study_note' | 'material',
        title: r.title || r.name || (r.record_type === 'study_note' ? '学习纪要' : '资料'),
        logicalPath: r.logical_path,
      }))
    );
    setNoteHelperVisible(true);
  };

  const handleNoteHelperGenerate = async (signal: { aborted: boolean }) => {
    let content = ''; let citations: Citation[] = [];
    await api.generateNoteStream(noteHelperSourceFiles, c => { content += c; }, c => { citations = c; }, undefined, signal);
    if (signal.aborted) return null;
    return { content, citations };
  };

  const fetchGraphData = useCallback(async () => {
    try {
      const res = await api.getGraphData();
      if (res.data) { setGraphData(res.data); setGraphError(null); }
    } catch (err) { setGraphError(String(err)); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { fetchGraphData(); }, [fetchGraphData]));

  // Auto-fit: center L1 node in viewport
  useEffect(() => {
    if (graphData && !initialFit) {
      setInitialFit(true);
      const l1Node = graphData.nodes.find(n => n.level === 'L1');
      // Graph usable area: width=SCREEN_W-24(margins), height≈SCREEN_H*0.55
      const gw = SCREEN_W - 24;
      const gh = SCREEN_H * 0.55;
      const defaultScale = Math.min(gw / CANVAS.w, gh / CANVAS.h) * 1.15;
      const s = defaultScale;
      scale.value = s;
      savedScale.value = s;
      if (l1Node) {
        // Center viewport on L1 node
        translateX.value = SCREEN_W / 2 - l1Node.x * s;
        translateY.value = gh * 0.45 - l1Node.y * s;
      } else {
        translateX.value = (SCREEN_W - CANVAS.w * s) / 2;
        translateY.value = 10;
      }
      savedTX.value = translateX.value;
      savedTY.value = translateY.value;
    }
  }, [graphData, initialFit]);

  // Zoom controls
  const zoomIn = () => {
    const newScale = Math.min(savedScale.value * 1.25, 5);
    const cx = SCREEN_W / 2;
    const cy = SCREEN_H * 0.35;
    translateX.value = cx - (cx - savedTX.value) * (newScale / savedScale.value);
    translateY.value = cy - (cy - savedTY.value) * (newScale / savedScale.value);
    savedTX.value = translateX.value;
    savedTY.value = translateY.value;
    savedScale.value = newScale;
    scale.value = newScale;
  };

  const zoomOut = () => {
    const newScale = Math.max(savedScale.value * 0.8, 0.2);
    const cx = SCREEN_W / 2;
    const cy = SCREEN_H * 0.35;
    translateX.value = cx - (cx - savedTX.value) * (newScale / savedScale.value);
    translateY.value = cy - (cy - savedTY.value) * (newScale / savedScale.value);
    savedTX.value = translateX.value;
    savedTY.value = translateY.value;
    savedScale.value = newScale;
    scale.value = newScale;
  };

  const onRefresh = () => {
    setRefreshing(true);
    viewMode === 'folder' ? fetchRecordsForFolder() : fetchGraphData();
  };

  const fetchRecordsForFolder = useCallback(async () => {
    setLoadingRecords(true);
    try { const res = await api.getRecentRecords(); setAllRecords(res.data || []); }
    catch { setAllRecords([]); }
    finally { setLoadingRecords(false); setRefreshing(false); }
  }, []);

  // Folder tree
  interface FolderDoc { id: string; title: string; type: 'study_note' | 'material'; papercore: string; logical_path: string; createdAt: string; }
  interface FolderNode { name: string; fullPath: string; subfolders: Map<string, FolderNode>; docs: FolderDoc[]; }

  const folderTree = useMemo(() => {
    const root = new Map<string, FolderNode>();
    allRecords.forEach((rec: any) => {
      const rawLp = rec.logical_path || '';
      let pathStr = rawLp;
      try { const p = JSON.parse(rawLp); if (Array.isArray(p) && p.length > 0) pathStr = p[0]; } catch {}
      pathStr = pathStr.replace(/^\[?"?\/?/, '/').replace(/\/?"?\]?$/, '/');
      const parts = pathStr.split('/').filter(Boolean);
      if (parts.length === 0) return;
      let cur = root; let soFar = '';
      parts.forEach((part: string, i: number) => {
        soFar += '/' + part;
        if (!cur.has(part)) cur.set(part, { name: part, fullPath: soFar + '/', subfolders: new Map(), docs: [] });
        const node = cur.get(part)!;
        if (i === parts.length - 1) {
          node.docs.push({ id: rec.id, title: rec.title || rec.name || '', type: rec.record_type || 'study_note', papercore: rec.papercore || '', logical_path: pathStr, createdAt: rec.created_at || '' });
        }
        cur = node.subfolders;
      });
    });
    return root;
  }, [allRecords]);

  // Gestures
  const pinchGesture = Gesture.Pinch()
    .onUpdate(e => { scale.value = Math.max(0.2, Math.min(savedScale.value * e.scale, 5)); })
    .onEnd(() => { savedScale.value = scale.value; });

  const panGesture = Gesture.Pan()
    .onUpdate(e => { translateX.value = savedTX.value + e.translationX; translateY.value = savedTY.value + e.translationY; })
    .onEnd(() => { savedTX.value = translateX.value; savedTY.value = translateY.value; });

  const composedGesture = Gesture.Simultaneous(pinchGesture, panGesture);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }, { translateY: translateY.value }, { scale: scale.value }] }));

  const tagMap = useMemo(() => {
    if (!graphData?.nodes) return new Map<string, TagNode>();
    return new Map(graphData.nodes.map(n => [n.id, n]));
  }, [graphData]);

  const toggleFolder = (path: string) => setExpandedFolders(prev => { const n = new Set(prev); n.has(path) ? n.delete(path) : n.add(path); return n; });
  const countFolder = (node: FolderNode): number => { let c = node.docs.length; node.subfolders.forEach(s => c += countFolder(s)); return c; };

  const handleSelectTag = async (tag: TagNode) => {
    setSelectedTag(tag); setLoadingTagDocs(true);
    try { const res = await api.getTagDocuments(tag.name); setTagDocuments(res.data || []); }
    catch { setTagDocuments([]); }
    finally { setLoadingTagDocs(false); }
  };

  // Build L2 cluster zones for visual grouping
  const l2Clusters = useMemo(() => {
    if (!graphData) return [];
    const l2Nodes = graphData.nodes.filter(n => n.level === 'L2');
    const l3Nodes = graphData.nodes.filter(n => n.level === 'L3');
    return l2Nodes.map((l2, i) => {
      const children = l3Nodes.filter(n => n.parentId === l2.id);
      if (children.length === 0) return null;
      const xs = children.map(c => c.x); const ys = children.map(c => c.y);
      xs.push(l2.x); ys.push(l2.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const rx = (Math.max(...xs) - Math.min(...xs)) / 2 + 60;
      const ry = (Math.max(...ys) - Math.min(...ys)) / 2 + 50;
      return { id: l2.id, name: l2.name, cx, cy, rx: Math.max(rx, 90), ry: Math.max(ry, 70), color: L2_CLUSTER_COLORS[i % L2_CLUSTER_COLORS.length] };
    }).filter(Boolean) as { id: string; name: string; cx: number; cy: number; rx: number; ry: number; color: string }[];
  }, [graphData]);

  // ==========================================
  // RENDER: Graph View
  // ==========================================
  const renderGraph = () => {
    if (!graphData) return null;

    const l1Count = graphData.nodes.filter(n => n.level === 'L1').length;
    const l2Count = graphData.nodes.filter(n => n.level === 'L2').length;
    const l3Count = graphData.nodes.filter(n => n.level === 'L3').length;

    return (
      <View style={{ flex: 1, position: 'relative' }}>
        {/* Canvas */}
        <View style={{
          flex: 1,
          minHeight: 400,
          backgroundColor: C.card,
          borderRadius: 24,
          marginHorizontal: 12,
          overflow: 'hidden',
          shadowColor: C.shadowDark,
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.25,
          shadowRadius: 12,
          elevation: 6,
        }}>
          <GestureDetector gesture={composedGesture}>
            <Animated.View style={[{ width: CANVAS.w, height: CANVAS.h }, animStyle]}>
              <Svg width={CANVAS.w} height={CANVAS.h} viewBox={`0 0 ${CANVAS.w} ${CANVAS.h}`}>
                {/* L2 cluster background zones */}
                {l2Clusters.map(cluster => (
                  <G key={`zone-${cluster.id}`}>
                    <Circle cx={cluster.cx} cy={cluster.cy} r={Math.max(cluster.rx, cluster.ry)} fill={cluster.color} opacity={0.6} />
                    <SvgText x={cluster.cx} y={cluster.cy - Math.max(cluster.rx, cluster.ry) + 18} textAnchor="middle" fontSize={12} fill={C.text2} fontWeight="600" opacity={0.7}>
                      {cluster.name}
                    </SvgText>
                  </G>
                ))}
                {/* Domain circles */}
                {graphData.domains.map((d, i) => (
                  <G key={`dom-${i}`}>
                    <Circle cx={d.cx} cy={d.cy} r={d.r} fill="none" stroke={C.primary} strokeWidth={1} strokeDasharray="8,6" opacity={0.25} />
                  </G>
                ))}
                {/* Edges */}
                {graphData.edges.filter(e => e.type === 'hierarchy').map((e, i) => {
                  const f = tagMap.get(e.from), t = tagMap.get(e.to);
                  if (!f || !t || f.level === 'L1') return null;
                  return <Line key={`h${i}`} x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke={C.primaryLight} strokeWidth={1.2} opacity={0.45} />;
                })}
                {graphData.edges.filter(e => e.type === 'cooccurrence').slice(0, 20).map((e, i) => {
                  const f = tagMap.get(e.from), t = tagMap.get(e.to);
                  if (!f || !t) return null;
                  const sw = Math.min((e.weight || 1) * 0.5 + 0.5, 2);
                  return <Line key={`c${i}`} x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke="#74B9FF" strokeWidth={sw} strokeDasharray="3,4" opacity={0.3} />;
                })}
                {/* L2 nodes */}
                {graphData.nodes.filter(n => n.level === 'L2').map(n => {
                  const s = NODE_STYLE.L2;
                  return (
                    <G key={n.id} onPress={() => handleSelectTag(n)}>
                      <Circle cx={n.x} cy={n.y} r={s.r} fill={s.fill} stroke={s.stroke} strokeWidth={s.strokeW} />
                      <SvgText x={n.x} y={n.y + s.fontSize / 3} textAnchor="middle" fontSize={s.fontSize} fill={s.fontColor} fontWeight="700">
                        {n.name.length > 4 ? n.name.slice(0, 4) : n.name}
                      </SvgText>
                      <SvgText x={n.x} y={n.y + s.r + 15} textAnchor="middle" fontSize={10} fill={C.text3} fontWeight="600">
                        {n.count}项
                      </SvgText>
                    </G>
                  );
                })}
                {/* L1 nodes */}
                {graphData.nodes.filter(n => n.level === 'L1').map(n => {
                  const s = NODE_STYLE.L1;
                  return (
                    <G key={n.id}>
                      <Circle cx={n.x} cy={n.y} r={s.r} fill={s.fill} stroke={s.stroke} strokeWidth={s.strokeW} />
                      <SvgText x={n.x} y={n.y + s.fontSize / 3} textAnchor="middle" fontSize={s.fontSize} fill={s.fontColor} fontWeight="800">
                        {n.name}
                      </SvgText>
                    </G>
                  );
                })}
                {/* L3 nodes */}
                {graphData.nodes.filter(n => n.level === 'L3').map(n => {
                  const s = NODE_STYLE.L3;
                  return (
                    <G key={n.id} onPress={() => handleSelectTag(n)}>
                      <Circle cx={n.x} cy={n.y} r={s.r} fill={s.fill} stroke={s.stroke} strokeWidth={s.strokeW} />
                      <SvgText x={n.x} y={n.y + s.r + 13} textAnchor="middle" fontSize={s.fontSize} fill={s.fontColor} fontWeight="500">
                        {n.name.length > 5 ? n.name.slice(0, 5) : n.name}
                      </SvgText>
                    </G>
                  );
                })}
              </Svg>
            </Animated.View>
          </GestureDetector>
        </View>

        {/* Zoom buttons — top right corner */}
        <View style={{ position: 'absolute', top: 12, right: 24, gap: 6, zIndex: 10 }}>
          <TouchableOpacity
            onPress={zoomIn}
            style={{
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: C.card,
              justifyContent: 'center', alignItems: 'center',
              shadowColor: C.shadowDark, shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.3, shadowRadius: 4, elevation: 4,
              borderWidth: 1, borderColor: C.border,
            }}
          >
            <Feather name="plus" size={20} color={C.text} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={zoomOut}
            style={{
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: C.card,
              justifyContent: 'center', alignItems: 'center',
              shadowColor: C.shadowDark, shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.3, shadowRadius: 4, elevation: 4,
              borderWidth: 1, borderColor: C.border,
            }}
          >
            <Feather name="minus" size={20} color={C.text} />
          </TouchableOpacity>
        </View>

        {/* Bottom bar: legend toggle + stats */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 16, paddingVertical: 8, marginTop: 4,
        }}>
          <TouchableOpacity
            onPress={() => setShowLegend(!showLegend)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 }}
          >
            <Feather name="info" size={14} color={C.text3} />
            <Text style={{ fontSize: 12, color: C.text3, fontWeight: '600' }}>图例</Text>
          </TouchableOpacity>

          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.primary }} />
              <Text style={{ fontSize: 10, color: C.text3 }}>{l1Count}领域</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.primaryLight }} />
              <Text style={{ fontSize: 10, color: C.text3 }}>{l2Count}模块</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, borderWidth: 1, borderColor: '#C4C8D8' }} />
              <Text style={{ fontSize: 10, color: C.text3 }}>{l3Count}知识</Text>
            </View>
            <Text style={{ fontSize: 10, color: C.text3, fontWeight: '600' }}>
              {graphData.totalRecords}条记录
            </Text>
          </View>
        </View>

        {/* Expandable legend */}
        {showLegend && (
          <View style={{
            flexDirection: 'row', flexWrap: 'wrap', gap: 8,
            marginHorizontal: 16, marginBottom: 8,
            backgroundColor: C.surface, borderRadius: 14, padding: 12,
          }}>
            <LegendChip color={C.primary} label="L1 学科领域" />
            <LegendChip color={C.primaryLight} label="L2 课程模块" outline />
            <LegendChip color="#C4C8D8" label="L3 知识点" outline small />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 18, height: 1.5, backgroundColor: C.primaryLight, borderRadius: 1 }} />
              <Text style={{ fontSize: 11, color: C.text3 }}>层级</Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 18, height: 1, borderWidth: 0.5, borderStyle: 'dashed', borderColor: '#74B9FF' }} />
              <Text style={{ fontSize: 11, color: C.text3 }}>共现</Text>
            </View>
          </View>
        )}
      </View>
    );
  };
  // ==========================================
  // RENDER: Folder View
  // ==========================================
  const renderFolderRow = (folders: Map<string, FolderNode>, depth: number = 0): React.ReactNode[] => {
    const sorted = Array.from(folders.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return sorted.flatMap(([key, node]) => {
      const expanded = expandedFolders.has(node.fullPath);
      const total = countFolder(node);
      const rows: React.ReactNode[] = [
        <TouchableOpacity key={node.fullPath} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingLeft: 16 + depth * 24, paddingRight: 16, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 }}
          onPress={() => toggleFolder(node.fullPath)}>
          <Feather name={expanded ? 'chevron-down' : 'chevron-right'} size={16} color={C.text3} />
          <Feather name="folder" size={18} color={expanded ? '#F59E0B' : '#FBBF24'} />
          <Text style={{ flex: 1, fontSize: 15, color: C.text, fontWeight: '600' }} numberOfLines={1}>{node.name}</Text>
          <Text style={{ fontSize: 12, color: C.text3, fontWeight: '500' }}>{total}</Text>
        </TouchableOpacity>,
      ];
      if (expanded) {
        if (node.subfolders.size > 0) rows.push(...renderFolderRow(node.subfolders, depth + 1));
        rows.push(...node.docs.map((doc, i) => {
          const selKey = `${doc.type}_${doc.id}`;
          const sel = selectedIds.has(selKey);
          return (
            <TouchableOpacity key={doc.id || `d${i}`}
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingLeft: 64 + depth * 24, paddingRight: 16, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 }}
              onPress={() => { if (selectMode) toggleSelect(doc); else router.push(doc.type === 'study_note' ? '/study-note-edit' : '/material-edit', { id: doc.id }); }}
              onLongPress={() => { if (!selectMode) enterSelectMode(doc); }}>
              {selectMode && <Feather name={sel ? 'check-square' : 'square'} size={18} color={sel ? C.primary : C.text3} />}
              <Feather name={doc.type === 'study_note' ? 'edit-3' : 'file-text'} size={14} color={doc.type === 'study_note' ? C.primary : C.accent} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, color: C.text, fontWeight: '500' }} numberOfLines={1}>{doc.title}</Text>
                {doc.papercore ? <Text style={{ fontSize: 10, color: C.text3, marginTop: 2 }} numberOfLines={1}>{doc.papercore}</Text> : null}
              </View>
              <Feather name="chevron-right" size={12} color={C.text3} />
            </TouchableOpacity>
          );
        }));
      }
      return rows;
    });
  };

  // ==========================================
  // MAIN RENDER
  // ==========================================
  return (
    <>
    <Screen statusBarStyle="dark" safeAreaEdges={['left', 'right', 'bottom']}>
      <View style={{ flex: 1 }}>
        {/* Header */}
        <View style={{ paddingTop: insets.top + 12, paddingHorizontal: 20, paddingBottom: 8 }}>
          <Text style={{ fontSize: 30, fontWeight: '800', color: C.text, letterSpacing: -0.5 }}>知识库</Text>
          {graphData && (
            <Text style={{ fontSize: 13, color: C.text3, marginTop: 2 }}>
              {graphData.nodes.length} 个标签 · {graphData.totalRecords} 条记录
            </Text>
          )}
        </View>

        {/* View toggle */}
        <View style={{ flexDirection: 'row', marginHorizontal: 16, marginBottom: 4, backgroundColor: C.bg, borderRadius: 14, padding: 4 }}>
          <ToggleBtn icon="account-tree" label="图谱" active={viewMode === 'graph'} onPress={() => setViewMode('graph')} />
          <ToggleBtn icon="folder" label="文件夹" active={viewMode === 'folder'} onPress={() => { setViewMode('folder'); fetchRecordsForFolder(); }} />
        </View>

        {/* Content */}
        {loading ? (
          <ScrollView scrollEnabled={false} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color={C.primary} />
          </ScrollView>
        ) : graphError ? (
          <ScrollView scrollEnabled={false} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Feather name="alert-triangle" size={48} color="#E17055" />
            <Text style={{ marginTop: 12, fontSize: 16, color: '#E17055', fontWeight: '600' }}>图谱加载失败</Text>
            <Text style={{ marginTop: 4, fontSize: 13, color: C.text3, textAlign: 'center' }}>{graphError}</Text>
            <TouchableOpacity style={{ marginTop: 16, backgroundColor: C.primary, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 14 }}
              onPress={() => { setLoading(true); setGraphError(null); fetchGraphData(); }}>
              <Text style={{ color: '#FFF', fontWeight: '600' }}>重试</Text>
            </TouchableOpacity>
          </ScrollView>
        ) : !graphData || graphData.nodes.length === 0 ? (
          <ScrollView scrollEnabled={false} style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Feather name="folder" size={64} color={C.shadow} />
            <Text style={{ marginTop: 16, fontSize: 17, color: C.text3, fontWeight: '600' }}>暂无知识记录</Text>
            <Text style={{ marginTop: 4, fontSize: 13, color: C.text3 }}>创建学习纪要或上传资料即可自动构建知识图谱</Text>
          </ScrollView>
        ) : viewMode === 'graph' ? (
          <View style={{ flex: 1 }}>
            <GraphErrorBoundary fallback={<FallbackCards graphData={graphData} onSelect={handleSelectTag} />}>
              {renderGraph()}
            </GraphErrorBoundary>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />} showsVerticalScrollIndicator={false}>
            {loadingRecords ? (
              <View style={{ padding: 48, alignItems: 'center' }}><ActivityIndicator size="large" color={C.primary} /></View>
            ) : (
              <View style={{ backgroundColor: C.card, borderRadius: 20, overflow: 'hidden', shadowColor: C.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 }}>
                {folderTree.size === 0 ? (
                  <View style={{ alignItems: 'center', padding: 40 }}>
                    <Feather name="folder" size={48} color={C.shadow} />
                    <Text style={{ fontSize: 16, color: C.text3, marginTop: 12 }}>暂无文件夹</Text>
                  </View>
                ) : (
                  <View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border, gap: 8 }}>
                      <Feather name="folder" size={16} color="#FBBF24" />
                      <Text style={{ fontSize: 14, fontWeight: '700', color: C.text }}>{allRecords.length} 条记录</Text>
                    </View>
                    {renderFolderRow(folderTree)}
                  </View>
                )}
              </View>
            )}
          </ScrollView>
        )}
      </View>

      {/* Tag Detail Bottom Sheet */}
      <Modal visible={!!selectedTag} animationType="slide" transparent>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: C.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '75%' }}>
            <View style={{ alignItems: 'center', paddingTop: 12, paddingBottom: 8 }}>
              <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: C.shadowDark }} />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.border }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {selectedTag && (
                  <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: selectedTag.level === 'L1' ? C.primary : selectedTag.level === 'L2' ? C.primaryLight : C.text3 }} />
                )}
                <Text style={{ fontSize: 18, fontWeight: '700', color: C.text }}>{selectedTag?.name}</Text>
                <View style={{ backgroundColor: C.primary + '18', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 }}>
                  <Text style={{ fontSize: 11, color: C.primary, fontWeight: '700' }}>{selectedTag?.level}</Text>
                </View>
              </View>
              <TouchableOpacity onPress={() => { setSelectedTag(null); setTagDocuments([]); }}>
                <Feather name="x" size={22} color={C.text2} />
              </TouchableOpacity>
            </View>
            {selectedTag && (
              <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 }}>
                <Text style={{ fontSize: 13, color: C.text2 }}>共 {selectedTag.count} 条关联记录</Text>
              </View>
            )}
            <ScrollView style={{ paddingHorizontal: 20, maxHeight: 400 }} showsVerticalScrollIndicator={false}>
              {loadingTagDocs ? (
                <View style={{ padding: 32, alignItems: 'center' }}><ActivityIndicator size="small" color={C.primary} /></View>
              ) : tagDocuments.length === 0 ? (
                <View style={{ padding: 24, alignItems: 'center' }}><Text style={{ color: C.text3 }}>暂无关联文档</Text></View>
              ) : (
                tagDocuments.map((doc, i) => (
                  <TouchableOpacity key={doc.id || i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: C.border, gap: 10 }}
                    onPress={() => { setSelectedTag(null); setTagDocuments([]); router.push(doc.type === 'study_note' ? '/study-note-edit' : '/material-edit', { id: doc.id }); }}>
                    <Feather name={doc.type === 'study_note' ? 'edit-3' : 'file-text'} size={18} color={doc.type === 'study_note' ? C.primary : C.accent} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '600', color: C.text }} numberOfLines={1}>{doc.title}</Text>
                      <Text style={{ fontSize: 11, color: C.text3, marginTop: 2 }} numberOfLines={1}>{doc.logical_path || ''}</Text>
                    </View>
                    <Feather name="chevron-right" size={14} color={C.text3} />
                  </TouchableOpacity>
                ))
              )}
              <View style={{ height: 32 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Multi-select bar (folder mode) */}
      {viewMode === 'folder' && selectMode && (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: C.card, borderTopWidth: 1, borderTopColor: C.border, paddingBottom: insets.bottom + 8, paddingHorizontal: 20, paddingTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 10, zIndex: 100 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity onPress={() => { setSelectMode(false); setSelectedIds(new Set()); }}>
              <Feather name="x" size={22} color={C.text2} />
            </TouchableOpacity>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.text }}>已选 {selectedIds.size} 个</Text>
          </View>
          <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: selectedIds.size > 0 ? C.primary : C.shadowDark, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 }}
            onPress={handleGenerateNote} disabled={selectedIds.size === 0}>
            <Feather name="edit-3" size={16} color="#FFF" />
            <Text style={{ color: '#FFF', fontWeight: '700', fontSize: 14 }}>生成笔记</Text>
          </TouchableOpacity>
        </View>
      )}
    </Screen>

    <NoteHelperPanel visible={noteHelperVisible} onClose={() => { setNoteHelperVisible(false); setSelectMode(false); setSelectedIds(new Set()); }}
      sourceFiles={noteHelperSourceFiles} onGenerate={handleNoteHelperGenerate} />
    </>
  );
}

// Mini components
function ToggleBtn({ icon, label, active, onPress }: { icon: string; label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 12, gap: 6, backgroundColor: active ? C.card : 'transparent', shadowColor: active ? C.shadow : undefined, shadowOffset: active ? { width: 0, height: 1 } : undefined, shadowOpacity: active ? 0.4 : 0, shadowRadius: active ? 4 : 0, elevation: active ? 2 : 0 }}
      onPress={onPress} activeOpacity={0.7}>
      <MaterialIcons name={icon as any} size={18} color={active ? C.primary : C.text3} />
      <Text style={{ fontSize: 14, fontWeight: '700', color: active ? C.primary : C.text3 }}>{label}</Text>
    </TouchableOpacity>
  );
}

function LegendChip({ color, label, outline, small }: { color: string; label: string; outline?: boolean; small?: boolean }) {
  const s = small ? 8 : 12;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: s, height: s, borderRadius: s / 2, backgroundColor: outline ? undefined : color, borderWidth: outline ? 2 : 0, borderColor: outline ? color : undefined }} />
      <Text style={{ fontSize: 11, color: C.text3, fontWeight: '500' }}>{label}</Text>
    </View>
  );
}

function FallbackCards({ graphData, onSelect }: { graphData: GraphData; onSelect: (tag: TagNode) => void }) {
  const { width: sw } = useWindowDimensions();
  return (
    <View style={{ paddingHorizontal: 16 }}>
      <View style={{ backgroundColor: '#FFF3E0', borderRadius: 14, padding: 14, marginBottom: 14, borderLeftWidth: 4, borderLeftColor: C.accent }}>
        <Text style={{ fontSize: 13, color: '#E65100', fontWeight: '600' }}>图形渲染暂不可用 — 共 {graphData.nodes.length} 个标签</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {graphData.nodes.map(node => (
          <TouchableOpacity key={node.id} style={{ width: (sw - 52) / 2, backgroundColor: C.card, borderRadius: 16, padding: 14, borderLeftWidth: 3, borderLeftColor: node.level === 'L1' ? C.primary : node.level === 'L2' ? C.primaryLight : C.text3 }}
            onPress={() => onSelect(node)}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: C.text }} numberOfLines={2}>{node.name}</Text>
            <Text style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>{node.level} · {node.count} 条记录</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}
