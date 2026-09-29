import { Fragment, useEffect, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { Uniwind } from 'uniwind';
import type { ThemeMode } from '@/contexts/ThemeModeContext';

function WebOnlyColorSchemeUpdater({
  children,
  mode,
}: {
  children?: ReactNode;
  mode: ThemeMode;
}) {
  useEffect(() => {
    if (Platform.OS === 'web') {
      Uniwind.setTheme(mode);
    }
  }, [mode]);

  return <Fragment>{children}</Fragment>;
}

export {
  WebOnlyColorSchemeUpdater,
};
