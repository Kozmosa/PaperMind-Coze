/**
 * MiniGraphPreview — 迷你知识图谱预览组件
 *
 * 用于 Knowledge Builder 等场景，展示一个新节点及其建议关系的小型力导向图。
 * Canvas: 350×250px，使用简单的力导向布局（30次迭代）。
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, Line, Text as SvgText, G } from 'react-native-svg';

const CANVAS_W = 350;
const CANVAS_H = 250;

const C = {
  centerFill: '#5B5FEF',
  centerStroke: '#8B8FF5',
  nodeFill: '#FFFFFF',
  nodeStroke: '#C4C8D8',
  prerequisiteStroke: '#FF6B6B',
  relatedStroke: '#4ECDC4',
  parentStroke: '#FFD93D',
  textPrimary: '#1E1E2E',
  textSecondary: '#6B7280',
  edgeDefault: '#D0D4E0',
};

export interface RelatedNode {
  id: number;
  short_name: string;
  relation_type: 'prerequisite' | 'related' | 'parent';
  score?: number;
}

interface MiniGraphPreviewProps {
  centerLabel: string;
  centerTags?: string[];
  relatedNodes: RelatedNode[];
  width?: number;
  height?: number;
}

interface LayoutNode {
  id: string;
  label: string;
  x: number;
  y: number;
  r: number;
  fill: string;
  stroke: string;
  isCenter: boolean;
}

interface LayoutEdge {
  fromId: string;
  toId: string;
  label: string;
  color: string;
}

function runForceLayout(
  centerName: string,
  related: RelatedNode[],
  w: number,
  h: number
): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  const centerId = 'center';

  // Center node at canvas center
  nodes.push({
    id: centerId,
    label: centerName.length > 8 ? centerName.substring(0, 8) + '...' : centerName,
    x: w / 2,
    y: h / 2,
    r: 22,
    fill: C.centerFill,
    stroke: C.centerStroke,
    isCenter: true,
  });

  // Place related nodes in a ring around the center
  const n = related.length;
  const ringRadius = Math.min(w, h) * 0.33;

  const relationColorMap: Record<string, string> = {
    prerequisite: C.prerequisiteStroke,
    related: C.relatedStroke,
    parent: C.parentStroke,
  };

  const relationLabelMap: Record<string, string> = {
    prerequisite: '前置',
    related: '相关',
    parent: '上层',
  };

  related.forEach((r, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    const id = `rel-${r.id}`;
    const label = r.short_name.length > 6 ? r.short_name.substring(0, 6) + '..' : r.short_name;

    nodes.push({
      id,
      label,
      x: w / 2 + ringRadius * Math.cos(angle),
      y: h / 2 + ringRadius * Math.sin(angle),
      r: 14,
      fill: C.nodeFill,
      stroke: relationColorMap[r.relation_type] || C.nodeStroke,
      isCenter: false,
    });

    edges.push({
      fromId: centerId,
      toId: id,
      label: relationLabelMap[r.relation_type] || r.relation_type,
      color: relationColorMap[r.relation_type] || C.edgeDefault,
    });
  });

  // Simple force relaxation (30 iterations)
  for (let iter = 0; iter < 30; iter++) {
    // Repulsion between non-center nodes
    for (let i = 1; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const minDist = nodes[i].r + nodes[j].r + 20;
        if (dist < minDist) {
          const force = (minDist - dist) * 0.1;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          nodes[i].x += fx;
          nodes[i].y += fy;
          nodes[j].x -= fx;
          nodes[j].y -= fy;
        }
      }
    }

    // Attraction to center (keep ring)
    for (let i = 1; i < nodes.length; i++) {
      const dx = nodes[i].x - w / 2;
      const dy = nodes[i].y - h / 2;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const targetDist = ringRadius;
      const force = (dist - targetDist) * 0.05;
      nodes[i].x -= (dx / dist) * force;
      nodes[i].y -= (dy / dist) * force;
    }

    // Boundary
    for (const node of nodes) {
      node.x = Math.max(node.r + 5, Math.min(w - node.r - 5, node.x));
      node.y = Math.max(node.r + 5, Math.min(h - node.r - 5, node.y));
    }
  }

  return { nodes, edges };
}

export default function MiniGraphPreview({
  centerLabel,
  centerTags,
  relatedNodes,
  width = CANVAS_W,
  height = CANVAS_H,
}: MiniGraphPreviewProps) {
  const { nodes, edges } = useMemo(
    () => runForceLayout(centerLabel, relatedNodes, width, height),
    [centerLabel, relatedNodes, width, height]
  );

  if (relatedNodes.length === 0) {
    return (
      <View style={[styles.container, { width, height }]}>
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyText}>暂无关系建议</Text>
          <Text style={styles.emptyHint}>确认 Papercore 后可获取建议</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { width, height }]}>
      <Text style={styles.title}>图谱预览</Text>
      <Svg width={width} height={height - 24}>
        {/* Edges */}
        {edges.map((edge, i) => {
          const fromNode = nodes.find(n => n.id === edge.fromId);
          const toNode = nodes.find(n => n.id === edge.toId);
          if (!fromNode || !toNode) return null;
          const mx = (fromNode.x + toNode.x) / 2;
          const my = (fromNode.y + toNode.y) / 2;
          return (
            <G key={`edge-${i}`}>
              <Line
                x1={fromNode.x} y1={fromNode.y}
                x2={toNode.x} y2={toNode.y}
                stroke={edge.color}
                strokeWidth={1.5}
                strokeDasharray={edge.label === '相关' ? '4,3' : undefined}
              />
              <SvgText
                x={mx} y={my - 6}
                fontSize={8}
                fill={edge.color}
                textAnchor="middle"
                fontWeight="600"
              >
                {edge.label}
              </SvgText>
            </G>
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => (
          <G key={node.id}>
            <Circle
              cx={node.x} cy={node.y} r={node.r}
              fill={node.fill}
              stroke={node.stroke}
              strokeWidth={node.isCenter ? 3 : 2}
            />
            <SvgText
              x={node.x} y={node.y + 3}
              fontSize={node.isCenter ? 10 : 8}
              fill={node.isCenter ? '#FFFFFF' : C.textSecondary}
              textAnchor="middle"
              fontWeight={node.isCenter ? '700' : '500'}
            >
              {node.label}
            </SvgText>
          </G>
        ))}
      </Svg>

      {/* Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: C.prerequisiteStroke }]} />
          <Text style={styles.legendText}>前置知识</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: C.relatedStroke }]} />
          <Text style={styles.legendText}>相关知识</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: C.parentStroke }]} />
          <Text style={styles.legendText}>上层概念</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#F7F8FC',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E8EAF0',
    padding: 10,
    overflow: 'hidden',
  },
  title: {
    fontSize: 12,
    fontWeight: '700',
    color: '#6B7280',
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyIcon: {
    fontSize: 28,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
  },
  emptyHint: {
    fontSize: 11,
    color: '#A0A5B5',
    marginTop: 4,
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginTop: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 10,
    color: '#6B7280',
  },
});
