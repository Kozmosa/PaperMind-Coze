import type { ReactNode } from 'react';

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
    <button
      type="button"
      role="tab"
      className={className}
      onClick={onPress}
      onContextMenu={onLongPress}
      aria-label={accessibilityLabel}
      aria-selected={accessibilityState?.selected}
    >
      {children}
    </button>
  );
}
