import { Platform, View } from 'react-native';
import { Tabs } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const theme = useTheme<MD3Theme>();

  const tabBarStyle = {
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.outlineVariant,
    paddingTop: 6,
    height: Platform.OS === 'web' ? ('auto' as any) : 58 + insets.bottom,
    paddingBottom: Platform.OS === 'web' ? 8 : insets.bottom + 2,
    elevation: 0,
  };

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Preserve the upstream desktop fix: labels must stay below icons.
        tabBarVariant: 'uikit',
        tabBarLabelPosition: 'below-icon',
        tabBarStyle,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
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
          tabBarIcon: ({ color, focused }) => (
            <MaterialCommunityIcons
              name={focused ? 'view-dashboard' : 'view-dashboard-outline'}
              size={22}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="knowledge"
        options={{
          title: '知识库',
          tabBarIcon: ({ color, focused }) => (
            <MaterialCommunityIcons
              name={focused ? 'book-multiple' : 'book-multiple-outline'}
              size={22}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'AI 助手',
          tabBarIcon: ({ focused }) => (
            <View
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: -10,
                backgroundColor: focused
                  ? theme.colors.primaryContainer
                  : theme.colors.surfaceVariant,
              }}
            >
              <MaterialCommunityIcons
                name="comment-processing-outline"
                size={22}
                color={focused ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="community"
        options={{
          title: '社区',
          tabBarIcon: ({ color, focused }) => (
            <MaterialCommunityIcons
              name={focused ? 'account-group' : 'account-group-outline'}
              size={22}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, focused }) => (
            <MaterialCommunityIcons
              name={focused ? 'account-circle' : 'account-circle-outline'}
              size={22}
              color={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}
