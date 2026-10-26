import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Tabs } from 'expo-router';
import { useEffect, useState, type ComponentProps } from 'react';
import { Animated, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardOpen } from './keyboard';
import { useStatus } from './status';
import { colors, shadow } from './theme';
import type { IconName } from './ui';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const ITEMS: { name: 'index' | 'tasks' | 'memory'; label: string; icon: IconName; active: IconName }[] = [
  { name: 'index', label: 'Разговор', icon: 'chatbubble-outline', active: 'chatbubble' },
  { name: 'tasks', label: 'Задачи', icon: 'checkmark-circle-outline', active: 'checkmark-circle' },
  { name: 'memory', label: 'Память', icon: 'sparkles-outline', active: 'sparkles' },
];

const PAD = 5;

/**
 * Плавающая панель на три вкладки: чернильная «таблетка» скользит под активным пунктом.
 * Отступ снизу берётся из safe-area, поэтому подписи не обрезаются на Android и iPhone.
 */
export function TabBar({ state }: TabBarProps) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const keyboardOpen = useKeyboardOpen();
  const { approvals } = useStatus();
  const [width, setWidth] = useState(0);
  const [slide] = useState(() => new Animated.Value(0));

  const current = state.routes[state.index]?.name;
  const index = ITEMS.findIndex((i) => i.name === current);
  const itemW = width > 0 ? (width - PAD * 2) / ITEMS.length : 0;

  useEffect(() => {
    if (index < 0 || itemW === 0) return;
    Animated.spring(slide, { toValue: index * itemW, speed: 22, bounciness: 7, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [index, itemW, slide]);

  if (keyboardOpen) return null; // клавиатура открыта — место нужнее ленте и полю ввода
  return (
    <View
      style={{
        backgroundColor: colors.bg,
        alignItems: 'center',
        paddingTop: 2,
        paddingBottom: Math.max(insets.bottom - 6, 8),
        paddingHorizontal: 16,
      }}
    >
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={[
          {
            flexDirection: 'row',
            width: '100%',
            maxWidth: 420,
            padding: PAD,
            borderRadius: 28,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.border,
          },
          shadow,
        ]}
      >
        {itemW > 0 && index >= 0 ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: PAD,
              left: PAD,
              bottom: PAD,
              width: itemW,
              borderRadius: 25,
              backgroundColor: colors.ink,
              transform: [{ translateX: slide }],
            }}
          />
        ) : null}
        {ITEMS.map((item, i) => {
          const focused = i === index;
          const badge = item.name === 'tasks' ? approvals : 0;
          return (
            <Pressable
              key={item.name}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={item.label}
              onPress={() => {
                if (!focused) router.navigate(item.name === 'index' ? '/' : item.name === 'tasks' ? '/tasks' : '/memory');
              }}
              style={{ flex: 1, height: 48, alignItems: 'center', justifyContent: 'center' }}
            >
              <View>
                <Ionicons
                  name={focused ? item.active : item.icon}
                  size={21}
                  color={focused ? colors.accentText : colors.muted}
                />
                {badge > 0 ? (
                  <View
                    style={{
                      position: 'absolute',
                      top: -4,
                      right: -10,
                      minWidth: 16,
                      height: 16,
                      borderRadius: 8,
                      paddingHorizontal: 4,
                      backgroundColor: colors.accent,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderWidth: 1.5,
                      borderColor: focused ? colors.ink : colors.surface,
                    }}
                  >
                    <Text style={{ color: colors.accentText, fontSize: 10, fontWeight: '700' }}>{badge > 9 ? '9+' : badge}</Text>
                  </View>
                ) : null}
              </View>
              <Text
                numberOfLines={1}
                style={{
                  marginTop: 2,
                  fontSize: 11,
                  fontWeight: '600',
                  letterSpacing: 0.2,
                  color: focused ? colors.accentText : colors.muted,
                }}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
