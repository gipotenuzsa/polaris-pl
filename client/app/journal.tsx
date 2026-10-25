import { useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import { api } from '../src/api';
import { formatDateTime } from '../src/format';
import { useLoad } from '../src/hooks';
import { colors, space, toolLabel } from '../src/theme';
import { Badge, Button, Card, Empty, ErrorNote, Loading, Muted, Row, Screen, confirmAction, notify } from '../src/ui';

const STATUS = {
  ok: { label: 'Выполнено', color: colors.success },
  error: { label: 'Ошибка', color: colors.danger },
  rejected: { label: 'Отклонено', color: colors.muted },
} as const;

export default function Journal() {
  const { data, error, loading, refresh } = useLoad(() => api.actions(150), 15_000);
  const [busy, setBusy] = useState<string | null>(null);

  const undo = async (id: string, summary: string) => {
    if (!(await confirmAction('Откатить действие?', summary, 'Откатить'))) return;
    setBusy(id);
    try {
      const r = await api.undoAction(id);
      notify('Готово', r.message);
      await refresh();
    } catch (e) {
      notify('Откат не удался', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen>
      {loading && !data ? <Loading /> : null}
      <ErrorNote message={error} onRetry={refresh} />
      <FlatList
        data={data?.items ?? []}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ padding: space.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        ListHeaderComponent={<Muted style={{ marginBottom: space.md }}>Секреты и ключи в журнал не попадают.</Muted>}
        ListEmptyComponent={
          !loading ? <Empty icon="list-outline" text="Журнал пуст: инструменты ещё не вызывались." /> : undefined
        }
        renderItem={({ item }) => {
          const st = STATUS[item.status];
          return (
            <Card>
              <Row style={{ justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ color: colors.text, fontWeight: '700', flex: 1 }}>
                  {item.tool.startsWith('undo:') ? `Откат: ${toolLabel(item.tool.slice(5))}` : toolLabel(item.tool)}
                </Text>
                <Badge label={item.undone ? 'Откатано' : st.label} color={item.undone ? colors.warn : st.color} />
              </Row>
              <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }} selectable>
                {item.summary}
              </Text>
              <View style={{ marginTop: 6 }}>
                <Muted>
                  {formatDateTime(item.createdAt)}
                  {item.taskId ? ' · фоновая задача' : ''}
                </Muted>
              </View>
              {item.undoable ? (
                <Button
                  title="Откатить"
                  variant="secondary"
                  icon="arrow-undo"
                  loading={busy === item.id}
                  onPress={() => undo(item.id, item.summary)}
                  style={{ marginTop: space.md }}
                />
              ) : null}
            </Card>
          );
        }}
      />
    </Screen>
  );
}
