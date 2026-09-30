import type { ReactNode } from 'react';
import { Pressable } from '@/components/ui';

interface GluestackTabButtonProps {
  className?: string;
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean };
}

export default function GluestackTabButton({
  className,
  children,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityState,
}: GluestackTabButtonProps) {
  return (
    <Pressable
      className={className}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="tab"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
    >
      {children}
    </Pressable>
  );
}
