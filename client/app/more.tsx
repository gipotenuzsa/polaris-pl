import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { api } from '../src/api';
import { useAuth } from '../src/auth';
import { Header } from '../src/Header';
import { useLoad } from '../src/hooks';
import { PressScale } from '../src/motion';
import { useStatus } from '../src/status';
import { colors, radius, space } from '../src/theme';
import { Button, Muted, Screen, type IconName } from '../src/ui';

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
    <PressScale
      onPress={onPress}
      scale={0.985}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        padding: space.lg,
        marginBottom: space.sm,
      }}
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
    </PressScale>
  );
}

export default function More() {
  const router = useRouter();
  const { signOut } = useAuth();
  const { unread, approvals } = useStatus();
  const { data: status } = useLoad(() => api.status(), 30_000);

  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Header title="Ещё" subtitle="Всё остальное в Polaris" back />
      <ScrollView contentContainerStyle={{ padding: space.lg, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
        <Item
          icon="shield-checkmark-outline"
          title="Подтверждения"
          hint="Рискованные действия ждут вашего «Одобрить»"
          badge={approvals}
          onPress={() => router.push('/approvals')}
        />
        <Item
          icon="notifications-outline"
          title="Уведомления"
          hint="Результаты задач, напоминания, сводки"
          badge={unread}
          onPress={() => router.push('/inbox')}
        />
        <Item
          icon="albums-outline"
          title="Архив тем"
          hint="Отдельные чаты вне основного разговора"
          onPress={() => router.push('/chats')}
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
