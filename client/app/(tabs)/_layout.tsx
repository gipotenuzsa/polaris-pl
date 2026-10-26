import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useStatus } from '../../src/status';
import { colors } from '../../src/theme';
import type { IconName } from '../../src/ui';

const icon = (name: IconName, focused: IconName) =>
  function TabIcon({ color, size, focused: f }: { color: ColorValue; size: number; focused: boolean }) {
    return <Ionicons name={f ? focused : name} size={size} color={color as string} />;
  };

export default function TabsLayout() {
  const { approvals, unread } = useStatus();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '600', fontSize: 18 },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border, elevation: 0 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarBadgeStyle: { backgroundColor: colors.accent, color: colors.accentText },
        animation: 'fade',
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Чаты', tabBarIcon: icon('chatbubbles-outline', 'chatbubbles') }} />
      <Tabs.Screen
        name="tasks"
        options={{ title: 'Задачи', tabBarIcon: icon('checkmark-done-circle-outline', 'checkmark-done-circle') }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: 'Подтверждения',
          tabBarIcon: icon('shield-checkmark-outline', 'shield-checkmark'),
          tabBarBadge: approvals > 0 ? approvals : undefined,
        }}
      />
      <Tabs.Screen name="memory" options={{ title: 'Память', tabBarIcon: icon('bulb-outline', 'bulb') }} />
      <Tabs.Screen
        name="more"
        options={{
          title: 'Ещё',
          tabBarIcon: icon('ellipsis-horizontal-circle-outline', 'ellipsis-horizontal-circle'),
          tabBarBadge: unread > 0 ? unread : undefined,
        }}
      />
    </Tabs>
  );
}
