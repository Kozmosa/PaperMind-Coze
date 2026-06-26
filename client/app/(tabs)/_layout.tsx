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
    shadowColor: '#D1D9E6',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
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
        tabBarInactiveTintColor: '#B2BEC3',
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
          tabBarIcon: ({ color }) => (
            <Feather name="grid" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="knowledge"
        options={{
          title: '知识库',
          tabBarIcon: ({ color }) => (
            <Feather name="book-open" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'AI 助手',
          tabBarIcon: ({ color, focused }) => (
            focused ? (
              <LinearGradient
                colors={['#6C63FF', '#8B7BF7']}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={{
                  width: 44, height: 44, borderRadius: 22,
                  justifyContent: 'center', alignItems: 'center',
                  marginTop: -12,
                  shadowColor: '#6C63FF',
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.3,
                  shadowRadius: 8,
                  elevation: 6,
                }}
              >
                <Feather name="message-circle" size={22} color="#FFF" />
              </LinearGradient>
            ) : (
              <View style={{
                width: 44, height: 44, borderRadius: 22,
                backgroundColor: '#E8E8EB',
                justifyContent: 'center', alignItems: 'center',
                marginTop: -12,
              }}>
                <Feather name="message-circle" size={22} color={color} />
              </View>
            )
          ),
        }}
      />
      <Tabs.Screen
        name="community"
        options={{
          title: '社区',
          tabBarIcon: ({ color }) => (
            <Feather name="users" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color }) => (
            <Feather name="user" size={22} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}