import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { api } from '../../src/api';
import { formatDateTime } from '../../src/format';
import { useLoad } from '../../src/hooks';
import { colors, radius, space } from '../../src/theme';
import type { MemoryItem } from '../../src/types';
import {
  Badge,
  Button,
  Card,
  Chip,
  Empty,
  ErrorNote,
  Input,
  Loading,
  Muted,
  Row,
  Screen,
  confirmAction,
  notify,
} from '../../src/ui';

const KIND_LABEL = { fact: 'Факт', preference: 'Предпочтение' } as const;

export default function Memory() {
  const { data, error, loading, refresh } = useLoad(() => api.memory());
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<{ id: string | null; kind: MemoryItem['kind']; content: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.items ?? []).filter((m) => !q || m.content.toLowerCase().includes(q));
  }, [data, query]);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      if (editing.id) await api.updateMemory(editing.id, { kind: editing.kind, content: editing.content });
      else await api.addMemory(editing.kind, editing.content);
      setEditing(null);
      await refresh();
    } catch (e) {
      notify('Не сохранено', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (m: MemoryItem) => {
    if (!(await confirmAction('Удалить запись из памяти?', m.content, 'Удалить'))) return;
    await api.deleteMemory(m.id).catch((e) => notify('Ошибка', String(e.message ?? e)));
    void refresh();
  };

  return (
    <Screen edges={['left', 'right']}>
      <Stack.Screen
        options={{
          headerTitle: 'Память',
          headerRight: () => (
            <Pressable
              onPress={() => setEditing({ id: null, kind: 'fact', content: '' })}
              style={{ paddingHorizontal: space.lg }}
              accessibilityLabel="Добавить запись"
            >
              <Ionicons name="add-circle-outline" size={28} color={colors.accent} />
            </Pressable>
          ),
        }}
      />
      {loading && !data ? <Loading /> : null}
      <ErrorNote message={error} onRetry={refresh} />
      <FlatList
        data={items}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: space.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        ListHeaderComponent={
          <View style={{ marginBottom: space.md }}>
            <Muted style={{ marginBottom: space.sm }}>
              Это всё, что Polaris помнит о вас между разговорами. Правьте и удаляйте записи свободно.
            </Muted>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Поиск по памяти"
              placeholderTextColor={colors.muted}
              style={{
                backgroundColor: colors.surface2,
                color: colors.text,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: colors.border,
                paddingHorizontal: space.md,
                paddingVertical: 10,
                fontSize: 15,
              }}
            />
          </View>
        }
        ListEmptyComponent={
          !loading ? (
            <Empty
              icon="bulb-outline"
              text="Память пуста. Расскажите Polaris о себе в чате или добавьте запись кнопкой ＋."
            />
          ) : undefined
        }
        renderItem={({ item }) => (
          <Card onPress={() => setEditing({ id: item.id, kind: item.kind, content: item.content })}>
            <Row style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <Badge label={KIND_LABEL[item.kind]} color={item.kind === 'fact' ? colors.accent : colors.success} />
              <Pressable onPress={() => remove(item)} hitSlop={10} accessibilityLabel="Удалить">
                <Ionicons name="trash-outline" size={18} color={colors.muted} />
              </Pressable>
            </Row>
            <Text style={{ color: colors.text, fontSize: 15, lineHeight: 21 }}>{item.content}</Text>
            <Muted style={{ marginTop: 6 }}>
              {item.source.startsWith('agent') ? 'Запомнил агент' : 'Добавлено вами'} · {formatDateTime(item.updatedAt)}
            </Muted>
          </Card>
        )}
      />
      <Modal visible={editing !== null} animationType="slide" transparent onRequestClose={() => setEditing(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
          <View
            style={{
              backgroundColor: colors.surface,
              padding: space.lg,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: space.md }}>
              {editing?.id ? 'Изменить запись' : 'Новая запись'}
            </Text>
            <Row style={{ marginBottom: space.md }}>
              <Chip
                label="Факт"
                active={editing?.kind === 'fact'}
                onPress={() => editing && setEditing({ ...editing, kind: 'fact' })}
              />
              <Chip
                label="Предпочтение"
                active={editing?.kind === 'preference'}
                onPress={() => editing && setEditing({ ...editing, kind: 'preference' })}
              />
            </Row>
            <Input
              value={editing?.content ?? ''}
              onChangeText={(t) => editing && setEditing({ ...editing, content: t })}
              multiline
              autoCapitalize="sentences"
              autoCorrect
              placeholder="Например: живу в Алматы, пишу код на TypeScript"
            />
            <Row>
              <Button
                title="Сохранить"
                onPress={save}
                loading={saving}
                disabled={(editing?.content.trim().length ?? 0) < 2}
                style={{ flex: 1, marginRight: space.sm }}
              />
              <Button title="Отмена" variant="secondary" onPress={() => setEditing(null)} style={{ flex: 1 }} />
            </Row>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
