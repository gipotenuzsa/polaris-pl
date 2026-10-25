import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../src/api';
import { formatDateTime, shorten } from '../src/format';
import { useLoad } from '../src/hooks';
import { colors, space } from '../src/theme';
import type { Note } from '../src/types';
import { Button, Card, Empty, ErrorNote, Input, Loading, Muted, Row, Screen, confirmAction, notify } from '../src/ui';

export default function Notes() {
  const { data, error, loading, refresh } = useLoad(() => api.notes());
  const [editing, setEditing] = useState<{ id: string | null; title: string; body: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await api.saveNote(editing.id, editing.title.trim(), editing.body);
      setEditing(null);
      await refresh();
    } catch (e) {
      notify('Не сохранено', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (n: Note) => {
    if (!(await confirmAction('Удалить заметку?', n.title, 'Удалить'))) return;
    await api.deleteNote(n.id).catch((e) => notify('Ошибка', String(e.message ?? e)));
    setEditing(null);
    void refresh();
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => setEditing({ id: null, title: '', body: '' })}
              style={{ paddingHorizontal: space.lg }}
              accessibilityLabel="Новая заметка"
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
        keyExtractor={(n) => n.id}
        contentContainerStyle={{ padding: space.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        ListEmptyComponent={
          !loading ? (
            <Empty
              icon="document-text-outline"
              text="Заметок нет. Попросите Polaris записать что-нибудь или добавьте заметку кнопкой ＋."
            />
          ) : undefined
        }
        renderItem={({ item }) => (
          <Card onPress={() => setEditing({ id: item.id, title: item.title, body: item.body })}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>{item.title}</Text>
            {item.body ? (
              <Text style={{ color: colors.muted, marginTop: 4 }} numberOfLines={3}>
                {shorten(item.body, 200)}
              </Text>
            ) : null}
            <Muted style={{ marginTop: 6 }}>{formatDateTime(item.updatedAt)}</Muted>
          </Card>
        )}
      />
      <Modal visible={editing !== null} animationType="slide" onRequestClose={() => setEditing(null)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView contentContainerStyle={{ padding: space.lg }} keyboardShouldPersistTaps="handled">
              <Input
                label="Заголовок"
                value={editing?.title ?? ''}
                onChangeText={(t) => editing && setEditing({ ...editing, title: t })}
                autoCapitalize="sentences"
              />
              <Input
                label="Текст"
                value={editing?.body ?? ''}
                onChangeText={(t) => editing && setEditing({ ...editing, body: t })}
                multiline
                autoCapitalize="sentences"
                autoCorrect
                style={{ minHeight: 220 }}
              />
              <Row>
                <Button
                  title="Сохранить"
                  onPress={save}
                  loading={saving}
                  disabled={!editing?.title.trim()}
                  style={{ flex: 1, marginRight: space.sm }}
                />
                <Button title="Закрыть" variant="secondary" onPress={() => setEditing(null)} style={{ flex: 1 }} />
              </Row>
              {editing?.id ? (
                <View style={{ marginTop: space.md }}>
                  <Button
                    title="Удалить заметку"
                    variant="ghost"
                    onPress={() => {
                      const n = data?.items.find((x) => x.id === editing.id);
                      if (n) void remove(n);
                    }}
                  />
                </View>
              ) : null}
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </Screen>
  );
}
