import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeModeValue {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

const DEFAULT_THEME: ThemeMode = 'light';
const STORAGE_KEY = 'papermind.theme-mode';
const ThemeModeContext = createContext<ThemeModeValue | undefined>(undefined);

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const systemTheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_THEME);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (!mounted) return;
        if (stored === 'light' || stored === 'dark') {
          setModeState(stored);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
    AsyncStorage.setItem(STORAGE_KEY, nextMode).catch(() => undefined);
  }, []);

  const value = useMemo<ThemeModeValue>(() => {
    const resolvedTheme: ResolvedTheme =
      mode === 'system' ? (systemTheme === 'dark' ? 'dark' : 'light') : mode;

    return {
      mode,
      resolvedTheme,
      isDark: resolvedTheme === 'dark',
      setMode,
      toggle: () => setMode(resolvedTheme === 'dark' ? 'light' : 'dark'),
    };
  }, [mode, setMode, systemTheme]);

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

export function useThemeMode() {
  const context = useContext(ThemeModeContext);
  if (!context) {
    throw new Error('useThemeMode must be used inside ThemeModeProvider');
  }
  return context;
}
