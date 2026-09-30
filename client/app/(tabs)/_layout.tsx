import { Tabs } from 'expo-router';
import GluestackTabBar from '@/components/layout/GluestackTabBar';

export default function TabLayout() {
  return (
    <Tabs tabBar={(props) => <GluestackTabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="control-center" options={{ title: '控制中心' }} />
      <Tabs.Screen name="knowledge" options={{ title: '知识库' }} />
      <Tabs.Screen name="index" options={{ title: 'AI 助手' }} />
      <Tabs.Screen name="community" options={{ title: '社区' }} />
      <Tabs.Screen name="profile" options={{ title: '我的' }} />
    </Tabs>
  );
}
