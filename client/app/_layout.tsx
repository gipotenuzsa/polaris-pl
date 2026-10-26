import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth';
import { registerServiceWorker } from '../src/push';
import { StatusProvider } from '../src/status';
import { colors } from '../src/theme';

/** Пока идёт проверка сессии, поверх навигации показываем заставку. */
function Gate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  return (
    <>
      {children}
      {state === 'loading' ? (
        <View style={styles.splash}>
          <ActivityIndicator color={colors.accent} size="large" />
        </View>
      ) : null}
    </>
  );
}

export default function RootLayout() {
  useEffect(() => {
    registerServiceWorker(); // нужен для Web Push; на нативных платформах ничего не делает
  }, []);
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusProvider>
          <StatusBar style="dark" />
          <Gate>
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.bg },
                headerTintColor: colors.text,
                headerTitleStyle: { fontWeight: '600', fontSize: 18 },
                animation: 'slide_from_right',
                headerShadowVisible: false,
                contentStyle: { backgroundColor: colors.bg },
                headerBackTitle: 'Назад',
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="login" options={{ headerShown: false }} />
              <Stack.Screen name="chats" options={{ headerShown: false }} />
              <Stack.Screen name="share" options={{ headerShown: false }} />
              <Stack.Screen name="more" options={{ headerShown: false }} />
              <Stack.Screen name="approvals" options={{ headerShown: false }} />
              <Stack.Screen name="chat/[id]" options={{ title: 'Чат' }} />
              <Stack.Screen name="task/new" options={{ title: 'Новая задача', presentation: 'modal' }} />
              <Stack.Screen name="task/[id]" options={{ title: 'Задача' }} />
              <Stack.Screen name="settings" options={{ title: 'Настройки' }} />
              <Stack.Screen name="journal" options={{ title: 'Журнал действий' }} />
              <Stack.Screen name="notes" options={{ title: 'Заметки' }} />
              <Stack.Screen name="files" options={{ title: 'Файлы' }} />
              <Stack.Screen name="inbox" options={{ title: 'Уведомления' }} />
            </Stack>
          </Gate>
        </StatusProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  },
});
