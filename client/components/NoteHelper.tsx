import { useState, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, TextInput, ScrollView, Animated, StyleSheet, Dimensions, Platform, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { api } from '@/utils/api';

type NoteEntry = {
  id: number;
  content: string;
  timestamp: string;
};

type NoteHelperProps = {
  nodeId: number | null;
  visible: boolean;
  onClose: () => void;
  // 节点信息，用于 AI 生成笔记
  nodeInfo?: {
    papercore?: string;
    tags?: string[];
    relations?: any;
  };
};

export default function NoteHelper({ nodeId, visible, onClose, nodeInfo }: NoteHelperProps) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [newNote, setNewNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const slideAnim = useRef(new Animated.Value(0)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const hasGeneratedRef = useRef(false);

  // 自动生成 AI 笔记
  const generateAiNote = async () => {
    console.log('NoteHelper: generateAiNote called, nodeId:', nodeId, 'hasGenerated:', hasGeneratedRef.current);
    if (!nodeId || hasGeneratedRef.current) {
      console.log('NoteHelper: generateAiNote skipped, no nodeId or already generated');
      return;
    }
    
    setGenerating(true);
    hasGeneratedRef.current = true;
    console.log('NoteHelper: Starting AI note generation...');
    
    try {
      const note = await api.generateNote({
        nodeId: Number(nodeId),
        papercore: nodeInfo?.papercore || '',
        tags: nodeInfo?.tags || [],
        relations: nodeInfo?.relations || {},
      });
      console.log('NoteHelper: generated note:', note?.substring(0, 100));
      if (note) {
        setAiNote(note);
      }
    } catch (e) {
      console.error('NoteHelper: Failed to generate AI note:', e);
    }
    setGenerating(false);
  };

  // Load notes when node changes
  const loadNotes = async () => {
    if (!nodeId) return;
    setLoading(true);
    try {
      const res = await api.getStickynotes();
      // Filter notes related to this node
      const nodeNotes = (res.data || []).filter((n: any) => 
        n.knowledge_node_id === nodeId || !n.knowledge_node_id
      );
      setNotes(nodeNotes.slice(0, 10));
    } catch (e) {
      console.error('Failed to load notes:', e);
    }
    setLoading(false);
  };

  // Load notes when node changes or component opens
  useEffect(() => {
    console.log('NoteHelper useEffect: visible=', visible, 'nodeId=', nodeId);
    if (visible && nodeId) {
      console.log('NoteHelper useEffect: triggering loadNotes and generateAiNote');
      hasGeneratedRef.current = false;
      setAiNote(null);
      loadNotes();
      setTimeout(() => generateAiNote(), 100);
    }
  }, [visible, nodeId]);

  // Toggle expanded state with animation
  const toggleExpanded = () => {
    const toValue = expanded ? 0 : 1;
    Animated.spring(translateX, {
      toValue: expanded ? 300 : 0,
      useNativeDriver: true,
      tension: 50,
      friction: 8,
    }).start();
    setExpanded(!expanded);
    
    if (!expanded && nodeId) {
      loadNotes();
    }
  };

  // Add new note
  const handleAddNote = async () => {
    if (!newNote.trim() || !nodeId) return;
    
    try {
      const res = await api.createStickynote({
        content: newNote.trim(),
        knowledge_node_id: nodeId,
        visibility: 'private',
      });
      setNotes([res.data, ...notes]);
      setNewNote('');
    } catch (e) {
      console.error('Failed to add note:', e);
    }
  };

  // Delete note
  const handleDeleteNote = async (id: number) => {
    try {
      await api.deleteStickynote(id);
      setNotes(notes.filter(n => n.id !== id));
    } catch (e) {
      console.error('Failed to delete note:', e);
    }
  };

  console.log('NoteHelper render:', { visible, expanded, nodeId });

  if (!visible) return null;

  return (
    <View style={styles.container}>
      {/* Label */}
      <View style={styles.labelContainer}>
        <Text style={styles.label}>笔记</Text>
      </View>
      {/* Toggle Button */}
      <TouchableOpacity style={styles.toggleButton} onPress={toggleExpanded}>
        <Feather name="edit-3" size={26} color="#FFF" />
        {nodeId && <View style={styles.badge}><Text style={styles.badgeText}>N</Text></View>}
      </TouchableOpacity>
      <Text style={styles.toggleText}>{expanded ? '关闭' : '点击'}</Text>

      {/* Expanded Panel */}
      {expanded && (
        <Animated.View 
          style={[
            styles.panel,
            { transform: [{ translateX: translateX }] }
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerTitle}>
              <Feather name="bookmark" size={18} color="#6C63FF" />
              <Text style={styles.headerText}>节点笔记</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Feather name="x" size={20} color="#666" />
            </TouchableOpacity>
          </View>

          {/* Input Area */}
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.input}
              placeholder="写下你的理解或疑问..."
              placeholderTextColor="#B2BEC3"
              value={newNote}
              onChangeText={setNewNote}
              multiline
              maxLength={500}
            />
            <TouchableOpacity 
              style={[styles.addBtn, !newNote.trim() && styles.addBtnDisabled]} 
              onPress={handleAddNote}
              disabled={!newNote.trim()}
            >
              <Feather name="send" size={18} color="#FFF" />
            </TouchableOpacity>
          </View>

          {/* AI 生成笔记 */}
          {generating ? (
            <View style={styles.aiNoteContainer}>
              <View style={styles.aiNoteHeader}>
                <Feather name="zap" size={16} color="#6C63FF" />
                <Text style={styles.aiNoteTitle}>AI 正在生成笔记...</Text>
              </View>
              <ActivityIndicator size="small" color="#6C63FF" style={{ marginTop: 8 }} />
            </View>
          ) : aiNote ? (
            <View style={styles.aiNoteContainer}>
              <View style={styles.aiNoteHeader}>
                <Feather name="zap" size={16} color="#6C63FF" />
                <Text style={styles.aiNoteTitle}>AI 生成的笔记</Text>
              </View>
              <Text style={styles.aiNoteContent}>{aiNote}</Text>
            </View>
          ) : null}

          {/* Notes List */}
          <ScrollView style={styles.notesList} showsVerticalScrollIndicator={false}>
            {notes.length === 0 && !aiNote && !generating ? (
              <View style={styles.emptyState}>
                <Feather name="inbox" size={32} color="#B2BEC3" />
                <Text style={styles.emptyText}>暂无笔记</Text>
                <Text style={styles.emptyHint}>写下对这个知识节点的理解</Text>
              </View>
            ) : (
              notes.map((note) => (
                <View key={note.id} style={styles.noteCard}>
                  <View style={styles.noteHeader}>
                    <Text style={styles.noteContent}>{note.content}</Text>
                    <TouchableOpacity onPress={() => handleDeleteNote(note.id)} style={styles.deleteBtn}>
                      <Feather name="trash-2" size={14} color="#E74C3C" />
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.noteTime}>
                    {new Date(note.timestamp).toLocaleDateString('zh-CN', { 
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
                    })}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>

          {/* Quick Actions */}
          <View style={styles.quickActions}>
            <TouchableOpacity style={styles.quickBtn}>
              <Feather name="zap" size={16} color="#6C63FF" />
              <Text style={styles.quickBtnText}>记忆技巧</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.quickBtn}>
              <Feather name="refresh-cw" size={16} color="#059669" />
              <Text style={styles.quickBtnText}>复习提醒</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.quickBtn}>
              <Feather name="share" size={16} color="#F59E0B" />
              <Text style={styles.quickBtnText}>分享</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    right: 16,
    top: '40%',
    zIndex: 9999,
    alignItems: 'center',
  },
  toggleButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#6C63FF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#6C63FF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 10,
    borderWidth: 4,
    borderColor: '#FFF',
  },
  labelContainer: {
    backgroundColor: '#6C63FF',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    marginBottom: 8,
  },
  label: {
    color: '#FFF',
    fontSize: 11,
    fontWeight: '700',
  },
  toggleIcon: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -8,
    backgroundColor: '#6C63FF',
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: '700',
  },
  toggleText: {
    fontSize: 11,
    color: '#6C63FF',
    fontWeight: '600',
    marginTop: 6,
    textAlign: 'center',
  },
  panel: {
    position: 'absolute',
    left: -280,
    top: 0,
    bottom: 0,
    width: 280,
    backgroundColor: '#F0F0F3',
    borderTopLeftRadius: 20,
    borderBottomLeftRadius: 20,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: -4, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2D3436',
  },
  closeBtn: {
    padding: 4,
  },
  inputContainer: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  input: {
    flex: 1,
    backgroundColor: '#FFF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: '#2D3436',
    maxHeight: 80,
  },
  addBtn: {
    backgroundColor: '#6C63FF',
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-end',
  },
  addBtnDisabled: {
    backgroundColor: '#B2BEC3',
  },
  notesList: {
    flex: 1,
    marginBottom: 12,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  emptyText: {
    fontSize: 14,
    color: '#636E72',
    marginTop: 8,
  },
  emptyHint: {
    fontSize: 12,
    color: '#B2BEC3',
    marginTop: 4,
  },
  noteCard: {
    backgroundColor: '#FFF',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  noteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  noteContent: {
    flex: 1,
    fontSize: 13,
    color: '#2D3436',
    lineHeight: 20,
  },
  deleteBtn: {
    padding: 4,
    marginLeft: 8,
  },
  noteTime: {
    fontSize: 11,
    color: '#B2BEC3',
    marginTop: 6,
  },
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.06)',
  },
  quickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(108, 99, 255, 0.08)',
    borderRadius: 8,
  },
  quickBtnText: {
    fontSize: 11,
    color: '#6C63FF',
    fontWeight: '500',
  },
  // AI 生成的笔记样式
  aiNoteContainer: {
    backgroundColor: 'rgba(108, 99, 255, 0.08)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#6C63FF',
  },
  aiNoteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  aiNoteTitle: {
    fontSize: 12,
    color: '#6C63FF',
    fontWeight: '600',
    marginLeft: 6,
  },
  aiNoteContent: {
    fontSize: 13,
    color: '#2D3436',
    lineHeight: 20,
  },
});
