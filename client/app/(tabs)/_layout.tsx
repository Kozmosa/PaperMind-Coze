import { Tabs } from 'expo-router';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useCSSVariable } from 'uniwind';
import { LinearGradient } from 'expo-linear-gradient';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const [background, muted, accent, foreground] = useCSSVariable([
    '--color-background',
    '--color-muted',
    '--color-accent',
    '--color-foreground',
  ]) as string[];

  const tabBarBg = background || '#F0F0F3';
  const tabColor = foreground || '#2D3436';

  let tabBarStyle: any = {
    backgroundColor: tabBarBg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 8,
    paddingBottom: insets.bottom + 4,
    height: Platform.OS === 'web' ? 'auto' : 60 + insets.bottom,
    borderTopWidth: 0,
    boxShadow: '0px -4px 8px rgba(209, 217, 230, 0.5)',
    elevation: 10,
  };

  if (Platform.OS === 'web') {
    tabBarStyle = {
      ...tabBarStyle,
      height: 'auto',
    };
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle,
        tabBarActiveTintColor: '#6C63FF',
        tabBarInactiveTintColor: '#8E8E93',
        // 桌面 Web 下（宽≥768 被视作平板）默认切换为标签在图标右侧的横排布局，
        // 行高不足导致标签被裁切（issue #2 P0），固定为「图标在上、标签在下」
        tabBarVariant: 'uikit',
        tabBarLabelPosition: 'below-icon',
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '600',
          marginTop: 2,
        },
      }}
    >
      <Tabs.Screen
        name="control-center"
        options={{
          title: '控制中心',
          tabBarIcon: ({ color }) => <Feather name="grid" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="knowledge"
        options={{
          title: '知识库',
          tabBarIcon: ({ color }) => <Feather name="book-open" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'AI 助手',
          tabBarIcon: ({ color, focused }) =>
            focused ? (
              <LinearGradient
                colors={['#6C63FF', '#8B7BF7']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginTop: -12,
                  boxShadow: '0px 4px 8px rgba(108, 99, 255, 0.3)',
                  elevation: 6,
                }}
              >
                <Feather name="message-circle" size={22} color="#FFF" />
              </LinearGradient>
            ) : (
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: 'rgba(108,99,255,0.12)',
                  justifyContent: 'center',
                  alignItems: 'center',
                  marginTop: -12,
                }}
              >
                <Feather name="message-circle" size={22} color="#6C63FF" />
              </View>
            ),
        }}
      />
      <Tabs.Screen
        name="community"
        options={{
          title: '社区',
          tabBarIcon: ({ color }) => <Feather name="users" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color }) => <Feather name="user" size={22} color={color} />,
        }}
      />
    </Tabs>
  );
}
