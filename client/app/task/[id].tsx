import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { api } from '../../src/api';
import { formatDateTime, formatSchedule, shorten } from '../../src/format';
import { useLoad } from '../../src/hooks';
import { useStatus } from '../../src/status';
import { TASK_STATUS, colors, space, toolLabel } from '../../src/theme';
import type { TaskStep } from '../../src/types';
import {
  Badge,
  Body,
  Button,
  Card,
  ErrorNote,
  Loading,
  Muted,
  Row,
  Screen,
  SectionTitle,
  confirmAction,
  notify,
} from '../../src/ui';

function describeStep(s: TaskStep): { icon: string; text: string; color: string } {
  const input = (s.input ?? {}) as Record<string, unknown>;
  const output = (s.output ?? {}) as Record<string, unknown>;
  const color = s.status === 'error' ? colors.danger : s.status === 'pending' ? colors.warn : colors.muted;
  switch (s.type) {
    case 'info':
      return { icon: '•', text: String(output.message ?? 'Событие'), color };
    case 'model': {
      const calls = (output.toolCalls as string[] | undefined) ?? [];
      return {
        icon: '💭',
        text: calls.length
          ? `Решил вызвать: ${calls.map(toolLabel).join(', ')}`
          : shorten(String(output.text ?? 'Ответ модели'), 200),
        color,
      };
    }
    case 'tool':
      return {
        icon: s.status === 'error' ? '✕' : '🔧',
        text: `${toolLabel(String(input.tool ?? ''))}: ${shorten(String(output.result ?? ''), 180)}`,
        color,
      };
    case 'approval':
      return {
        icon: '🛡',
        text:
          s.status === 'pending'
            ? `Ждёт подтверждения: ${String(output.summary ?? '')}`
            : `Решение: ${String(output.decision ?? s.status)}`,
        color,
      };
    case 'result':
      return { icon: '✓', text: shorten(String(output.text ?? ''), 300), color: colors.success };
    case 'error':
      return { icon: '⚠', text: String(output.error ?? 'Ошибка'), color: colors.danger };
    default:
      return { icon: '•', text: s.type, color };
  }
}

export default function TaskDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { refresh: refreshStatus } = useStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const { data, error, loading, refresh } = useLoad(
    () => api.task(id),
    (d) =>
      d?.task.status === 'in_progress' || d?.task.status === 'scheduled'
        ? 2500
        : d?.task.status === 'awaiting_approval'
          ? 6000
          : undefined,
    [id],
  );

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
      await refresh();
      void refreshStatus();
    } catch (e) {
      notify('Ошибка', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Loading />;
  const task = data?.task;
  const st = task ? (TASK_STATUS[task.status] ?? { label: task.status, color: colors.muted }) : undefined;
  const active = task?.status === 'scheduled' || task?.status === 'in_progress' || task?.status === 'awaiting_approval';

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.lg }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
      >
        <ErrorNote message={error} onRetry={refresh} />
        {task && st ? (
          <>
            <Card>
              <Row style={{ justifyContent: 'space-between', marginBottom: space.sm }}>
                <Badge label={st.label} color={st.color} />
                <Muted>Запусков: {task.runCount}</Muted>
              </Row>
              <Body>{task.goal}</Body>
              <Muted style={{ marginTop: space.sm }}>
                {formatSchedule(task.schedule)}
                {task.nextRunAt && task.status === 'scheduled'
                  ? ` · следующий запуск ${formatDateTime(task.nextRunAt)}`
                  : ''}
              </Muted>
            </Card>

            {task.status === 'awaiting_approval' ? (
              <Card style={{ borderColor: '#ff9f6b' }}>
                <Body>Задача остановилась и ждёт вашего решения.</Body>
                <Button
                  title="Открыть подтверждения"
                  onPress={() => router.push('/approvals')}
                  style={{ marginTop: space.md }}
                />
              </Card>
            ) : null}

            {task.lastResult ? (
              <>
                <SectionTitle>Итог последнего запуска</SectionTitle>
                <Card>
                  <Body>{task.lastResult}</Body>
                </Card>
              </>
            ) : null}
            {task.lastError ? (
              <Card style={{ borderColor: colors.danger }}>
                <Text style={{ color: colors.danger }} selectable>
                  {task.lastError}
                </Text>
              </Card>
            ) : null}

            <Row style={{ flexWrap: 'wrap', marginTop: space.sm }}>
              {task.status !== 'in_progress' && task.status !== 'awaiting_approval' ? (
                <Button
                  title="Запустить сейчас"
                  icon="play"
                  loading={busy === 'run'}
                  onPress={() => act('run', () => api.runTask(task.id))}
                  style={{ marginRight: space.sm, marginBottom: space.sm }}
                />
              ) : null}
              {active ? (
                <Button
                  title="Отменить"
                  variant="secondary"
                  loading={busy === 'cancel'}
                  onPress={async () => {
                    if (await confirmAction('Отменить задачу?', task.goal, 'Отменить'))
                      await act('cancel', () => api.cancelTask(task.id));
                  }}
                  style={{ marginRight: space.sm, marginBottom: space.sm }}
                />
              ) : null}
              <Button
                title="Удалить"
                variant="ghost"
                loading={busy === 'delete'}
                onPress={async () => {
                  if (!(await confirmAction('Удалить задачу?', 'Вместе с историей шагов.', 'Удалить'))) return;
                  await act('delete', async () => {
                    await api.deleteTask(task.id);
                    router.back();
                  });
                }}
                style={{ marginBottom: space.sm }}
              />
            </Row>

            {task.conversationId ? (
              <Button
                title="Открыть диалог агента"
                variant="secondary"
                icon="chatbubble-outline"
                onPress={() => router.push(`/chat/${task.conversationId}`)}
              />
            ) : null}

            <SectionTitle>Шаги</SectionTitle>
            {data?.steps.length ? (
              data.steps.map((s) => {
                const d = describeStep(s);
                return (
                  <View key={s.id} style={{ flexDirection: 'row', marginBottom: 10 }}>
                    <Text style={{ width: 24, color: d.color }}>{d.icon}</Text>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{
                          color: d.color === colors.muted ? colors.text : d.color,
                          fontSize: 14,
                          lineHeight: 20,
                        }}
                        selectable
                      >
                        {d.text}
                      </Text>
                      <Muted>
                        Запуск {s.runNo} · {formatDateTime(s.createdAt)}
                      </Muted>
                    </View>
                  </View>
                );
              })
            ) : (
              <Muted>Шагов пока нет.</Muted>
            )}
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
