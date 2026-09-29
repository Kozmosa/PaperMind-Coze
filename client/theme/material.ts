import { MD3DarkTheme, MD3LightTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';

export const materialPalette = {
  light: {
    primary: '#5B4FE0',
    onPrimary: '#FFFFFF',
    primaryContainer: '#E7E3FF',
    onPrimaryContainer: '#1F1A63',
    secondary: '#5F6378',
    onSecondary: '#FFFFFF',
    secondaryContainer: '#E5E7F1',
    onSecondaryContainer: '#1C1E2C',
    tertiary: '#00796B',
    onTertiary: '#FFFFFF',
    tertiaryContainer: '#D1F2EC',
    onTertiaryContainer: '#00201C',
    error: '#B3261E',
    onError: '#FFFFFF',
    errorContainer: '#F9DEDC',
    onErrorContainer: '#410E0B',
    background: '#F6F4FF',
    onBackground: '#1B1B21',
    surface: '#FFFFFF',
    onSurface: '#1B1B21',
    surfaceVariant: '#ECEAF6',
    onSurfaceVariant: '#484653',
    outline: '#777586',
    outlineVariant: '#C9C7D4',
    inverseSurface: '#303036',
    inverseOnSurface: '#F3EFF7',
  },
  dark: {
    primary: '#C4BEFF',
    onPrimary: '#271E6B',
    primaryContainer: '#40379A',
    onPrimaryContainer: '#E7E3FF',
    secondary: '#C6C5DC',
    onSecondary: '#2E3043',
    secondaryContainer: '#454659',
    onSecondaryContainer: '#E2E1F7',
    tertiary: '#7FD8C8',
    onTertiary: '#003731',
    tertiaryContainer: '#005048',
    onTertiaryContainer: '#D1F2EC',
    error: '#F2B8B5',
    onError: '#601410',
    errorContainer: '#8C1D18',
    onErrorContainer: '#F9DEDC',
    background: '#111118',
    onBackground: '#E5E1E9',
    surface: '#191922',
    onSurface: '#E5E1E9',
    surfaceVariant: '#2A2A36',
    onSurfaceVariant: '#CBC7D8',
    outline: '#9591A4',
    outlineVariant: '#4A4857',
    inverseSurface: '#E5E1E9',
    inverseOnSurface: '#303036',
  },
} as const;

export function createMaterialTheme(dark: boolean): MD3Theme {
  const base = dark ? MD3DarkTheme : MD3LightTheme;
  const colors = materialPalette[dark ? 'dark' : 'light'];

  return {
    ...base,
    version: 3,
    roundness: 16,
    colors: {
      ...base.colors,
      ...colors,
    },
  };
}
