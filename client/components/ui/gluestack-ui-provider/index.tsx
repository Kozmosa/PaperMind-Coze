import React, { useEffect } from 'react';
import { View } from 'react-native';
import { OverlayProvider } from '@gluestack-ui/core/overlay/creator';
import { ToastProvider } from '@gluestack-ui/core/toast/creator';
import { Uniwind } from 'uniwind';

export type ModeType = 'light' | 'dark' | 'system';

export function GluestackUIProvider({
  mode = 'dark',
  ...props
}: {
  mode?: ModeType;
  children?: React.ReactNode;
}) {
  useEffect(() => {
    if (mode === 'system') {
      Uniwind.setTheme('system');
    } else {
      Uniwind.setTheme(mode);
    }
  }, [mode]);

  return (
    <View className="h-full w-full flex-1">
      <OverlayProvider>
        <ToastProvider>{props.children}</ToastProvider>
      </OverlayProvider>
    </View>
  );
}
