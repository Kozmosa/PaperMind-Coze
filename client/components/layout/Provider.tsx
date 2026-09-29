import { type ReactNode } from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PaperProvider } from 'react-native-paper';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeModeProvider, useThemeMode } from '@/contexts/ThemeModeContext';
import { WebOnlyColorSchemeUpdater } from './ColorSchemeUpdater';
import { WebOnlyPrettyScrollbar } from './PrettyScrollbar';
import { createMaterialTheme } from '@/theme/material';

function MaterialProviders({ children }: { children: ReactNode }) {
  const { mode, isDark } = useThemeMode();

  return (
    <WebOnlyColorSchemeUpdater mode={mode}>
      <WebOnlyPrettyScrollbar>
        <PaperProvider theme={createMaterialTheme(isDark)}>
          <StatusBar style={isDark ? 'light' : 'dark'} translucent />
          {children}
        </PaperProvider>
      </WebOnlyPrettyScrollbar>
    </WebOnlyColorSchemeUpdater>
  );
}

function Provider({ children }: { children: ReactNode }) {
  return (
    <ThemeModeProvider>
      <AuthProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <MaterialProviders>{children}</MaterialProviders>
        </GestureHandlerRootView>
      </AuthProvider>
    </ThemeModeProvider>
  );
}

export {
  Provider,
};
