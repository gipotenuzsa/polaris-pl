import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { api } from '../../src/api';
import { formatDateTime, formatSchedule, shorten } from '../../src/format';
import { useLoad } from '../../src/hooks';
import { TASK_STATUS, colors, space } from '../../src/theme';
import { Badge, Card, Empty, ErrorNote, Loading, Screen } from '../../src/ui';

export default function Tasks() {
  const router = useRouter();
  const { data, error, loading, refresh } = useLoad(
    () => api.tasks(),
    (d) => (d?.items.some((t) => t.status === 'in_progress' || t.status === 'scheduled') ? 5000 : 15000),
  );

  return (
    <Screen edges={['left', 'right']}>
      <Stack.Screen
        options={{
          headerTitle: 'Фоновые задачи',
          headerRight: () => (
            <Pressable
              onPress={() => router.push('/task/new')}
              style={{ paddingHorizontal: space.lg }}
              accessibilityLabel="Новая задача"
            >
              <Ionicons name="add-circle-outline" size={28} color={colors.accent} />
            </Pressable>
          ),
        }}
      />
      {loading && !data ? <Loading /> : null}
      <ErrorNote message={error} onRetry={refresh} />
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ padding: space.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        ListEmptyComponent={
          !loading ? (
            <Empty
              icon="checkmark-done-circle-outline"
              text="Задач пока нет. Поставьте цель — Polaris выполнит её сам и пришлёт результат."
            />
          ) : undefined
        }
        renderItem={({ item }) => {
          const st = TASK_STATUS[item.status] ?? { label: item.status, color: colors.muted };
          return (
            <Card onPress={() => router.push(`/task/${item.id}`)}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Text
                  style={{ color: colors.text, fontSize: 16, fontWeight: '600', flex: 1, marginRight: space.sm }}
                  numberOfLines={2}
                >
                  {item.goal}
                </Text>
                <Badge label={st.label} color={st.color} />
              </View>
              <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>
                {formatSchedule(item.schedule)}
                {item.nextRunAt && item.status === 'scheduled'
                  ? ` · следующий запуск ${formatDateTime(item.nextRunAt)}`
                  : ''}
              </Text>
              {item.lastResult ? (
                <Text style={{ color: colors.muted, fontSize: 13, marginTop: 6 }} numberOfLines={2}>
                  Итог: {shorten(item.lastResult, 140)}
                </Text>
              ) : null}
              {item.lastError ? (
                <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }} numberOfLines={2}>
                  {shorten(item.lastError, 140)}
                </Text>
              ) : null}
            </Card>
          );
        }}
      />
    </Screen>
  );
}
