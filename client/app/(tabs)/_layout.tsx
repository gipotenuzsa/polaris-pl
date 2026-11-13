import { Tabs } from 'expo-router';
import { colors } from '../../src/theme';

/**
 * Сохраняем маршруты задач и памяти; основная навигация находится в ChatWorkspace.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={() => null}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg }, animation: 'fade' }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="tasks" />
      <Tabs.Screen name="memory" />
    </Tabs>
  );
}
