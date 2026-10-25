import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { api } from '../src/api';
import { formatDateTime } from '../src/format';
import { useLoad } from '../src/hooks';
import { useStatus } from '../src/status';
import { colors, space } from '../src/theme';
import type { AppNotification } from '../src/types';
import { Card, Empty, ErrorNote, Loading, Screen } from '../src/ui';

const ICON: Record<AppNotification['kind'], { name: React.ComponentProps<typeof Ionicons>['name']; color: string }> = {
  reminder: { name: 'alarm-outline', color: colors.warn },
  task_done: { name: 'checkmark-circle-outline', color: colors.success },
  task_failed: { name: 'alert-circle-outline', color: colors.danger },
  approval: { name: 'shield-checkmark-outline', color: '#ff9f6b' },
  morning: { name: 'sunny-outline', color: colors.warn },
  info: { name: 'information-circle-outline', color: colors.accent },
};

export default function Inbox() {
  const router = useRouter();
  const { refresh: refreshStatus } = useStatus();
  const { data, error, loading, refresh } = useLoad(() => api.notifications(), 20_000);

  const open = async (n: AppNotification) => {
    if (!n.read) await api.markRead(n.id).catch(() => undefined);
    void refreshStatus();
    if (n.kind === 'approval') router.push('/approvals');
    else if (n.ref?.conversationId) router.push(`/chat/${n.ref.conversationId}`);
    else if (n.ref?.taskId) router.push(`/task/${n.ref.taskId}`);
    else void refresh();
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          headerRight: () =>
            data?.unread ? (
              <Pressable
                onPress={async () => {
                  await api.markAllRead();
                  await refresh();
                  void refreshStatus();
                }}
                style={{ paddingHorizontal: space.lg }}
              >
                <Text style={{ color: colors.accent }}>Прочитать все</Text>
              </Pressable>
            ) : null,
        }}
      />
      {loading && !data ? <Loading /> : null}
      <ErrorNote message={error} onRetry={refresh} />
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ padding: space.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        ListEmptyComponent={!loading ? <Empty icon="notifications-outline" text="Пока ничего нового." /> : undefined}
        renderItem={({ item }) => {
          const ic = ICON[item.kind] ?? ICON.info;
          return (
            <Card onPress={() => open(item)} style={{ opacity: item.read ? 0.7 : 1 }}>
              <View style={{ flexDirection: 'row' }}>
                <Ionicons name={ic.name} size={22} color={ic.color} />
                <View style={{ flex: 1, marginLeft: space.md }}>
                  <Text style={{ color: colors.text, fontWeight: item.read ? '500' : '700', fontSize: 15 }}>
                    {item.title}
                  </Text>
                  {item.body ? (
                    <Text style={{ color: colors.muted, fontSize: 14, marginTop: 3 }} numberOfLines={4}>
                      {item.body}
                    </Text>
                  ) : null}
                  <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>
                    {formatDateTime(item.createdAt)}
                  </Text>
                </View>
                {!item.read ? (
                  <View
                    style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, marginTop: 6 }}
                  />
                ) : null}
              </View>
            </Card>
          );
        }}
      />
    </Screen>
  );
}
