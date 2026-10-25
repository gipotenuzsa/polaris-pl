import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { api } from '../../src/api';
import { formatDateTime } from '../../src/format';
import { useLoad } from '../../src/hooks';
import { colors, radius, space } from '../../src/theme';
import { Empty, ErrorNote, Loading, Screen, confirmAction, notify } from '../../src/ui';
import type { Conversation } from '../../src/types';

export default function Chats() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const { data, error, loading, refresh } = useLoad(async () => {
    const [chats, summaries] = await Promise.all([api.conversations('chat'), api.conversations('summary')]);
    return [...chats.conversations, ...summaries.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });

  const create = async () => {
    setCreating(true);
    try {
      const { conversation } = await api.createConversation();
      router.push(`/chat/${conversation.id}`);
    } catch (e) {
      notify('Не удалось создать чат', e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (c: Conversation) => {
    if (!(await confirmAction('Удалить чат?', c.title, 'Удалить'))) return;
    await api.deleteConversation(c.id).catch((e) => notify('Ошибка', String(e.message ?? e)));
    void refresh();
  };

  return (
    <Screen edges={['left', 'right']}>
      <Stack.Screen
        options={{
          headerTitle: 'Polaris',
          headerRight: () => (
            <Pressable
              onPress={create}
              disabled={creating}
              style={{ paddingHorizontal: space.lg }}
              accessibilityLabel="Новый чат"
            >
              <Ionicons name="create-outline" size={24} color={colors.accent} />
            </Pressable>
          ),
        }}
      />
      {loading && !data ? <Loading /> : null}
      <ErrorNote message={error} onRetry={refresh} />
      <FlatList
        data={data ?? []}
        keyExtractor={(c) => c.id}
        contentContainerStyle={{ padding: space.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        ListEmptyComponent={
          !loading ? (
            <Empty text="Чатов пока нет. Нажмите ✎ вверху и напишите Polaris." icon="chatbubbles-outline" />
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/chat/${item.id}`)}
            onLongPress={() => remove(item)}
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
              name={item.kind === 'summary' ? 'sunny-outline' : 'chatbubble-outline'}
              size={22}
              color={colors.accent}
            />
            <View style={{ flex: 1, marginLeft: space.md }}>
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{formatDateTime(item.updatedAt)}</Text>
            </View>
            <Pressable onPress={() => remove(item)} hitSlop={10} accessibilityLabel="Удалить чат">
              <Ionicons name="trash-outline" size={18} color={colors.muted} />
            </Pressable>
          </Pressable>
        )}
      />
    </Screen>
  );
}
