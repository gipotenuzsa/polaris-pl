import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';
import { useLoad } from '../../src/hooks';
import { useStatus } from '../../src/status';
import { colors, radius, space } from '../../src/theme';
import { Button, Muted, Screen, type IconName } from '../../src/ui';

function Item({
  icon,
  title,
  hint,
  badge,
  onPress,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  badge?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        padding: space.lg,
        marginBottom: space.sm,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Ionicons name={icon} size={22} color={colors.accent} />
      <View style={{ flex: 1, marginLeft: space.md }}>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>{title}</Text>
        {hint ? <Text style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>{hint}</Text> : null}
      </View>
      {badge ? (
        <View
          style={{
            backgroundColor: colors.accent,
            borderRadius: 10,
            minWidth: 20,
            paddingHorizontal: 6,
            alignItems: 'center',
            marginRight: 8,
          }}
        >
          <Text style={{ color: colors.accentText, fontSize: 12, fontWeight: '700' }}>{badge}</Text>
        </View>
      ) : null}
      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
    </Pressable>
  );
}

export default function More() {
  const router = useRouter();
  const { signOut } = useAuth();
  const { unread } = useStatus();
  const { data: status } = useLoad(() => api.status(), 30_000);

  return (
    <Screen edges={['left', 'right']}>
      <Stack.Screen options={{ headerTitle: 'Ещё' }} />
      <ScrollView contentContainerStyle={{ padding: space.lg }}>
        <Item
          icon="notifications-outline"
          title="Уведомления"
          hint="Результаты задач, напоминания, сводки"
          badge={unread}
          onPress={() => router.push('/inbox')}
        />
        <Item icon="document-text-outline" title="Заметки" onPress={() => router.push('/notes')} />
        <Item
          icon="folder-outline"
          title="Файлы"
          hint={status?.files === 'supabase' ? 'Supabase Storage' : 'Локальное хранилище'}
          onPress={() => router.push('/files')}
        />
        <Item
          icon="list-outline"
          title="Журнал действий"
          hint="Каждый вызов инструмента; откат, где возможен"
          onPress={() => router.push('/journal')}
        />
        <Item
          icon="settings-outline"
          title="Настройки"
          hint="Провайдеры, ChatGPT, бюджет, утренняя сводка"
          onPress={() => router.push('/settings')}
        />
        <View style={{ marginTop: space.lg }}>
          {status ? (
            <Muted style={{ textAlign: 'center', marginBottom: space.md }}>
              Polaris {status.version} · инструментов: {status.tools.length} · часовой пояс {status.timezone}
            </Muted>
          ) : null}
          <Button title="Выйти" variant="secondary" icon="log-out-outline" onPress={signOut} />
        </View>
      </ScrollView>
    </Screen>
  );
}
