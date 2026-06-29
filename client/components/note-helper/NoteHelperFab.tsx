import { TouchableOpacity, StyleSheet, View, Text } from 'react-native';
import { Feather } from '@expo/vector-icons';

type NoteHelperFabProps = {
  onPress: () => void;
  visible?: boolean;
  /** 是否自动选中当前页面（详情页唤醒时为 true） */
  selected?: boolean;
};

export default function NoteHelperFab({ onPress, visible = true, selected = false }: NoteHelperFabProps) {
  if (!visible) return null;

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[styles.fab, selected && styles.fabSelected]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <Feather name="zap" size={24} color={selected ? '#FFF' : '#6C63FF'} />
      </TouchableOpacity>
      <Text style={styles.label}>AI 生成笔记</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    right: 16,
    bottom: 120,
    zIndex: 9999,
    alignItems: 'center',
  },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.78)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#6C63FF',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 6,
    borderWidth: 2,
    borderColor: 'rgba(108,99,255,0.55)',
  },
  fabSelected: {
    backgroundColor: 'rgba(108,99,255,0.82)',
  },
  label: {
    fontSize: 10,
    color: 'rgba(108,99,255,0.75)',
    fontWeight: '600',
    marginTop: 4,
    textAlign: 'center',
  },
});
