import type { ComponentProps } from 'react';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Feather } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind, useCSSVariable } from 'uniwind';
import { HStack, Text } from '@/components/ui';
import GluestackTabButton from './GluestackTabButton';

type IconName = ComponentProps<typeof Feather>['name'];

const ICONS: Record<string, IconName> = {
  'control-center': 'grid',
  knowledge: 'book-open',
  index: 'message-circle',
  community: 'users',
  profile: 'user',
};

const StyledSafeAreaView = withUniwind(SafeAreaView);

function GluestackTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const [primary, muted] = useCSSVariable(['--color-primary', '--color-muted-foreground']) as [
    string,
    string,
  ];

  return (
    <StyledSafeAreaView edges={['bottom']} className="bg-background">
      <HStack className="web:h-auto border-border gap-1 border-t px-1 py-1">
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const options = descriptors[route.key]?.options;
          const label = typeof options?.title === 'string' ? options.title : route.name;
          const icon = ICONS[route.name] ?? 'circle';

          const onPress = () => {
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });

            if (!event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          const onLongPress = () => {
            navigation.emit({
              type: 'tabLongPress',
              target: route.key,
            });
          };

          return (
            <GluestackTabButton
              key={route.key}
              onPress={onPress}
              onLongPress={onLongPress}
              accessibilityState={{ selected: focused }}
              accessibilityLabel={label}
              className={`web:focus-visible:ring-2 web:focus-visible:ring-primary font-inherit min-w-0 flex-1 cursor-pointer appearance-none items-center justify-center gap-1 rounded-xl border-0 bg-transparent px-1 py-1 text-inherit ${
                focused ? 'bg-secondary' : 'bg-transparent'
              }`}
            >
              <Feather name={icon} size={20} color={focused ? primary : muted} />
              <Text size="sm" className={focused ? 'text-primary' : 'text-muted-foreground'}>
                {label}
              </Text>
            </GluestackTabButton>
          );
        })}
      </HStack>
    </StyledSafeAreaView>
  );
}

export default GluestackTabBar;
