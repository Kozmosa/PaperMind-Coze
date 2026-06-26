import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LogBox } from 'react-native';
import Toast from 'react-native-toast-message';
import { Provider } from '@/components/Provider';
import { useAuth } from '@/contexts/AuthContext';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useSegments, useRootNavigationState } from 'expo-router';
import { useEffect } from 'react';

import '../global.css';

LogBox.ignoreLogs([
  "TurboModuleRegistry.getEnforcing(...): 'RNMapsAirModule' could not be found",
]);

function AuthGuard({ children }: { children: React.ReactNode }) {
  const rootState = useRootNavigationState();
  const segments = useSegments();
  const { isAuthenticated, isLoading } = useAuth();
  const router = useSafeRouter();

  useEffect(() => {
    if (!rootState?.key || isLoading) return;
    const inLoginRoute = segments.includes('login');
    if (!isAuthenticated && !inLoginRoute) {
      router.replace('/login');
    }
    if (isAuthenticated && inLoginRoute) {
      router.replace('/(tabs)');
    }
  }, [rootState?.key, isAuthenticated, isLoading, segments]);

  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <Provider>
      <AuthGuard>
        <Stack
          screenOptions={{
            animation: 'slide_from_right',
            gestureEnabled: true,
            gestureDirection: 'horizontal',
            headerShown: false,
          }}
        >
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="forum-detail" options={{ headerShown: false }} />
          <Stack.Screen name="reflection-detail" options={{ headerShown: false }} />
          <Stack.Screen name="draft-pool" options={{ headerShown: false }} />
          <Stack.Screen name="ai-chat" options={{ headerShown: false }} />
          <Stack.Screen name="study-note-edit" options={{ headerShown: false }} />
          <Stack.Screen name="material-edit" options={{ headerShown: false }} />
          <Stack.Screen name="problem-solving-logs" options={{ headerShown: false }} />
          <Stack.Screen name="reflection" options={{ headerShown: false }} />
        </Stack>
        <Toast />
      </AuthGuard>
    </Provider>
  );
}