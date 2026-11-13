import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useChatWorkspace } from '../src/ChatWorkspace';
import { Header } from '../src/Header';
import { colors, space } from '../src/theme';
import { Empty, ErrorNote, Input, Loading, Screen } from '../src/ui';

/** The full history uses the same actions and data as the sidebar. */
export default function Chats() {
  const router = useRouter();
  const { conversations, chatsLoading, chatsError, newChat, refreshChats, showChatMenu } = useChatWorkspace();
  const [query, setQuery] = useState('');
  const chats = useMemo(() => {
    const term = query.trim().toLowerCase();
    return conversations.filter((chat) => !term || `${chat.title} ${chat.preview ?? ''}`.toLowerCase().includes(term));
  }, [conversations, query]);
  return (
    <Screen>
      <Header
        title="Все чаты"
        subtitle="Каждая тема — отдельный разговор"
        back
        actions={[{ icon: 'create-outline', label: 'Новый чат', onPress: newChat }]}
      />
      <ErrorNote message={chatsError} onRetry={refreshChats} />
      {chatsLoading ? <Loading /> : null}
      <FlatList
        data={chats}
        keyExtractor={(chat) => chat.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ width: '100%', maxWidth: 780, alignSelf: 'center', padding: space.lg, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refreshChats} tintColor={colors.accent} />}
        ListHeaderComponent={
          <Input
            accessibilityLabel="Поиск в истории"
            value={query}
            onChangeText={setQuery}
            placeholder="Поиск по чатам"
          />
        }
        ListEmptyComponent={
          !chatsLoading ? (
            <Empty
              icon="chatbubbles-outline"
              text={query ? 'Ничего не найдено' : 'Начните новый разговор — он появится здесь.'}
            />
          ) : undefined
        }
        renderItem={({ item }) => (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              borderBottomWidth: 1,
              borderBottomColor: colors.border,
            }}
          >
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/chat/${item.id}`)}
              style={{ flex: 1, paddingVertical: 17, paddingRight: 10 }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {item.pinned ? <Ionicons name="pin" size={13} color={colors.accent} /> : null}
                <Text numberOfLines={1} style={{ color: colors.text, fontSize: 16, fontWeight: '500', flex: 1 }}>
                  {item.title}
                </Text>
              </View>
              <Text numberOfLines={1} style={{ fontSize: 13, color: colors.muted, marginTop: 5 }}>
                {item.preview || 'Пока нет сообщений'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Действия с чатом: ${item.title}`}
              onPress={() => showChatMenu(item)}
              style={{ padding: 12 }}
            >
              <Ionicons name="ellipsis-horizontal" size={20} color={colors.muted} />
            </Pressable>
          </View>
        )}
      />
    </Screen>
  );
}
