import { Tabs } from 'expo-router';
import { TabBar } from '../../src/TabBar';
import { colors } from '../../src/theme';

/**
 * Три основные вкладки: Чаты · Задачи · Память. Подтверждения живут в «Задачах» (и на экране «Ещё»),
 * уведомления и настройки — в шапке «Чатов»; эти экраны остаются маршрутами, но без своей вкладки.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg }, animation: 'fade' }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="tasks" />
      <Tabs.Screen name="memory" />
    </Tabs>
  );
}
