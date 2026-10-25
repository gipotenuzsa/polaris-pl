import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../src/api';
import { formatBytes, formatDateTime } from '../src/format';
import { useLoad } from '../src/hooks';
import { colors, radius, space } from '../src/theme';
import type { FileEntry } from '../src/types';
import { Button, Empty, ErrorNote, Loading, Muted, Row, Screen, confirmAction, notify } from '../src/ui';

export default function Files() {
  const [path, setPath] = useState('');
  const [viewing, setViewing] = useState<{ entry: FileEntry; text: string } | null>(null);
  const { data, error, loading, refresh } = useLoad(() => api.files(path), undefined, [path]);

  const open = async (e: FileEntry) => {
    if (e.isDir) return setPath(e.path);
    try {
      setViewing({ entry: e, text: await api.fileText(e.path) });
    } catch (err) {
      notify('Не удалось открыть файл', err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (e: FileEntry) => {
    if (
      !(await confirmAction(
        'Удалить файл?',
        `${e.path}\n\nФайл уйдёт в корзину и его можно вернуть через журнал.`,
        'Удалить',
      ))
    )
      return;
    await api.deleteFile(e.path).catch((err) => notify('Ошибка', String(err.message ?? err)));
    setViewing(null);
    void refresh();
  };

  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  return (
    <Screen>
      {loading && !data ? <Loading /> : null}
      <ErrorNote message={error} onRetry={refresh} />
      <FlatList
        data={data?.entries ?? []}
        keyExtractor={(e) => e.path}
        contentContainerStyle={{ padding: space.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        ListHeaderComponent={
          <Row style={{ marginBottom: space.md }}>
            {path ? (
              <Pressable onPress={() => setPath(parent)} style={{ marginRight: space.md }} accessibilityLabel="Наверх">
                <Ionicons name="arrow-up-circle-outline" size={26} color={colors.accent} />
              </Pressable>
            ) : null}
            <Text style={{ color: colors.muted, flex: 1 }}>/{path}</Text>
          </Row>
        }
        ListEmptyComponent={
          !loading ? (
            <Empty icon="folder-open-outline" text="Здесь пусто. Файлы создаёт агент по вашей просьбе." />
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => open(item)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: colors.surface,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: colors.border,
              padding: space.md,
              marginBottom: space.sm,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Ionicons
              name={item.isDir ? 'folder' : 'document-text-outline'}
              size={22}
              color={item.isDir ? colors.warn : colors.accent}
            />
            <View style={{ flex: 1, marginLeft: space.md }}>
              <Text style={{ color: colors.text, fontSize: 15 }} numberOfLines={1}>
                {item.name}
              </Text>
              {!item.isDir ? (
                <Muted>
                  {formatBytes(item.size)}
                  {item.updatedAt ? ` · ${formatDateTime(item.updatedAt)}` : ''}
                </Muted>
              ) : null}
            </View>
            {!item.isDir ? (
              <Pressable onPress={() => remove(item)} hitSlop={10} accessibilityLabel="Удалить файл">
                <Ionicons name="trash-outline" size={18} color={colors.muted} />
              </Pressable>
            ) : null}
          </Pressable>
        )}
      />
      <Modal visible={viewing !== null} animationType="slide" onRequestClose={() => setViewing(null)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
          <ScrollView contentContainerStyle={{ padding: space.lg }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16, marginBottom: space.md }}>
              {viewing?.entry.path}
            </Text>
            <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }} selectable>
              {viewing?.text}
            </Text>
            <Row style={{ marginTop: space.lg }}>
              <Button
                title="Закрыть"
                variant="secondary"
                onPress={() => setViewing(null)}
                style={{ flex: 1, marginRight: space.sm }}
              />
              <Button
                title="Удалить"
                variant="danger"
                onPress={() => viewing && remove(viewing.entry)}
                style={{ flex: 1 }}
              />
            </Row>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </Screen>
  );
}
