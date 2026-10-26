import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Tabs } from 'expo-router';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardOpen } from './keyboard';
import { useStatus } from './status';
import { colors } from './theme';
import type { IconName } from './ui';

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const ITEMS: { name: 'index' | 'tasks' | 'memory'; label: string; icon: IconName; active: IconName }[] = [
  { name: 'index', label: 'Разговор', icon: 'chatbubble-outline', active: 'chatbubble' },
  { name: 'tasks', label: 'Задачи', icon: 'checkmark-circle-outline', active: 'checkmark-circle' },
  { name: 'memory', label: 'Память', icon: 'sparkles-outline', active: 'sparkles' },
];

const INDICATOR = 26;
const MAX_WIDTH = 460;

/**
 * Плоская панель на три вкладки: тонкая линия сверху, без плашек и теней. Активный пункт отмечен
 * терракотовым штрихом, который плавно скользит между вкладками. Отступ снизу берётся из safe-area.
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
  const itemW = width > 0 ? Math.min(width, MAX_WIDTH) / ITEMS.length : 0;

  const placed = useRef(false);
  useEffect(() => {
    if (index < 0 || itemW === 0) return;
    const target = index * itemW + (itemW - INDICATOR) / 2;
    if (!placed.current) {
      placed.current = true;
      slide.setValue(target); // при первом показе штрих сразу на своём месте, без «заезда» слева
      return;
    }
    Animated.spring(slide, { toValue: target, speed: 22, bounciness: 5, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [index, itemW, slide]);

  if (keyboardOpen) return null; // клавиатура открыта — место нужнее ленте и полю ввода
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        backgroundColor: colors.bg,
        borderTopWidth: StyleSheet.hairlineWidth * 2,
        borderTopColor: colors.border,
        alignItems: 'center',
        paddingBottom: Math.max(insets.bottom - 8, 6),
      }}
    >
      <View style={{ flexDirection: 'row', width: '100%', maxWidth: MAX_WIDTH }}>
        {itemW > 0 && index >= 0 ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: -1,
              left: 0,
              width: INDICATOR,
              height: 2.5,
              borderRadius: 2,
              backgroundColor: colors.accent,
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
              style={{ flex: 1, height: 52, alignItems: 'center', justifyContent: 'center' }}
            >
              <View>
                <Ionicons name={focused ? item.active : item.icon} size={22} color={focused ? colors.text : colors.muted} />
                {badge > 0 ? (
                  <View
                    style={{
                      position: 'absolute',
                      top: -3,
                      right: -9,
                      minWidth: 15,
                      height: 15,
                      borderRadius: 8,
                      paddingHorizontal: 4,
                      backgroundColor: colors.accent,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: colors.accentText, fontSize: 9, fontWeight: '700' }}>{badge > 9 ? '9+' : badge}</Text>
                  </View>
                ) : null}
              </View>
              <Text
                numberOfLines={1}
                style={{
                  marginTop: 2,
                  fontSize: 10.5,
                  fontWeight: focused ? '600' : '500',
                  letterSpacing: 0.3,
                  color: focused ? colors.text : colors.muted,
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
