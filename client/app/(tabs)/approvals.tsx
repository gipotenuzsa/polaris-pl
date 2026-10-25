import { Stack } from 'expo-router';
import { FlatList, RefreshControl } from 'react-native';
import { api } from '../../src/api';
import { ApprovalCard } from '../../src/ApprovalCard';
import { useLoad } from '../../src/hooks';
import { useStatus } from '../../src/status';
import { colors, space } from '../../src/theme';
import { Empty, ErrorNote, Loading, Muted, Screen, SectionTitle } from '../../src/ui';

export default function Approvals() {
  const { refresh: refreshStatus } = useStatus();
  const { data, error, loading, refresh } = useLoad(() => api.approvals(), 6000);
  const items = data?.items ?? [];
  const pending = items.filter((a) => a.status === 'pending');
  const done = items.filter((a) => a.status !== 'pending').slice(0, 20);
  const onResolved = () => {
    void refresh();
    void refreshStatus();
  };

  return (
    <Screen edges={['left', 'right']}>
      <Stack.Screen options={{ headerTitle: 'Подтверждения' }} />
      {loading && !data ? <Loading /> : null}
      <ErrorNote message={error} onRetry={refresh} />
      <FlatList
        data={[...pending, ...done]}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ padding: space.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        ListHeaderComponent={
          <>
            <Muted>
              Polaris выполняет рискованные действия — удаление, перезапись, отправку, действия в браузере — только
              после вашего «Одобрить».
            </Muted>
            {pending.length ? <SectionTitle>Ждут решения ({pending.length})</SectionTitle> : null}
          </>
        }
        ListEmptyComponent={
          !loading ? <Empty icon="shield-checkmark-outline" text="Нет действий, ожидающих подтверждения." /> : undefined
        }
        renderItem={({ item, index }) => (
          <>
            {index === pending.length && done.length ? <SectionTitle>Недавние решения</SectionTitle> : null}
            <ApprovalCard approval={item} onResolved={onResolved} />
          </>
        )}
      />
    </Screen>
  );
}
