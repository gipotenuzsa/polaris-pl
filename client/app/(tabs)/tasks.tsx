import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { api } from '../../src/api';
import { ApprovalCard } from '../../src/ApprovalCard';
import { formatDateTime, formatSchedule, shorten } from '../../src/format';
import { Header } from '../../src/Header';
import { useLoad } from '../../src/hooks';
import { FadeIn, PressScale } from '../../src/motion';
import { useStatus } from '../../src/status';
import { TASK_STATUS, colors, radius, space } from '../../src/theme';
import type { Task } from '../../src/types';
import { Badge, Empty, ErrorNote, Loading, Screen, SectionTitle } from '../../src/ui';

function TaskRow({ task, index, onOpen }: { task: Task; index: number; onOpen: () => void }) {
  const st = TASK_STATUS[task.status] ?? { label: task.status, color: colors.muted };
  return (
    <FadeIn delay={Math.min(index, 8) * 35} distance={6}>
      <PressScale
        onPress={onOpen}
        scale={0.985}
        style={{
          backgroundColor: colors.surface,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          padding: space.lg,
          marginBottom: space.sm,
        }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600', flex: 1, marginRight: space.sm }} numberOfLines={2}>
            {task.goal}
          </Text>
          <Badge label={st.label} color={st.color} />
        </View>
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 6 }}>
          {formatSchedule(task.schedule)}
          {task.nextRunAt && task.status === 'scheduled' ? ` · следующий запуск ${formatDateTime(task.nextRunAt)}` : ''}
        </Text>
        {task.lastResult ? (
          <Text style={{ color: colors.muted, fontSize: 13, marginTop: 6 }} numberOfLines={2}>
            Итог: {shorten(task.lastResult, 140)}
          </Text>
        ) : null}
        {task.lastError ? (
          <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }} numberOfLines={2}>
            {shorten(task.lastError, 140)}
          </Text>
        ) : null}
      </PressScale>
    </FadeIn>
  );
}

export default function Tasks() {
  const router = useRouter();
  const { refresh: refreshStatus } = useStatus();
  const { data, error, loading, refresh } = useLoad(
    () => api.tasks(),
    (d) => (d?.items.some((t) => t.status === 'in_progress' || t.status === 'scheduled') ? 5000 : 15000),
  );
  const approvals = useLoad(() => api.approvals(), 6000);
  const pending = (approvals.data?.items ?? []).filter((a) => a.status === 'pending');
  const items = data?.items ?? [];
  const active = items.filter((t) => t.status === 'scheduled' || t.status === 'in_progress' || t.status === 'awaiting_approval').length;

  const onResolved = () => {
    void approvals.refresh();
    void refresh();
    void refreshStatus();
  };

  return (
    <Screen edges={['left', 'right']}>
      <Header
        title="Задачи"
        subtitle={active ? `Активных: ${active}` : 'Фоновая работа Polaris'}
        actions={[{ icon: 'add', label: 'Новая задача', primary: true, onPress: () => router.push('/task/new') }]}
      />
      {loading && !data ? <Loading /> : null}
      <ErrorNote message={error} onRetry={refresh} />
      <FlatList
        data={items}
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xl, flexGrow: 1, width: '100%', maxWidth: 760, alignSelf: 'center' }}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => {
              void refresh();
              void approvals.refresh();
            }}
            tintColor={colors.accent}
          />
        }
        ListHeaderComponent={
          pending.length ? (
            <View style={{ marginBottom: space.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.sm }}>
                <Ionicons name="shield-checkmark" size={16} color={colors.attention} />
                <SectionTitle>Ждут вашего решения · {pending.length}</SectionTitle>
              </View>
              {pending.slice(0, 3).map((a) => (
                <ApprovalCard key={a.id} approval={a} onResolved={onResolved} />
              ))}
              {pending.length > 3 ? (
                <Text onPress={() => router.push('/approvals')} style={{ color: colors.accent, fontSize: 14, marginBottom: space.sm }}>
                  Показать все ({pending.length})
                </Text>
              ) : null}
              {items.length ? <SectionTitle>Задачи</SectionTitle> : null}
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          !loading ? (
            <Empty
              icon="checkmark-done-circle-outline"
              text="Задач пока нет. Поставьте цель — Polaris выполнит её сам и пришлёт результат."
            />
          ) : undefined
        }
        renderItem={({ item, index }) => <TaskRow task={item} index={index} onOpen={() => router.push(`/task/${item.id}`)} />}
      />
    </Screen>
  );
}
