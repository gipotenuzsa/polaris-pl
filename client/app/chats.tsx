import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlatList, Modal, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { api } from '../src/api';
import { Header } from '../src/Header';
import { useLoad } from '../src/hooks';
import { FadeIn, PressScale } from '../src/motion';
import { colors, radius, shadow, space } from '../src/theme';
import type { Conversation } from '../src/types';
import { Button, Empty, ErrorNote, Input, Loading, Screen, confirmAction, notify } from '../src/ui';

type Row = { type: 'title'; id: string; title: string } | { type: 'chat'; id: string; chat: Conversation; index: number };

/** Превью без Markdown-разметки: **жирный**, `код`, заголовки, ссылки. */
const plain = (t: string) =>
  t
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const tf = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const wf = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const df = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

function group(c: Conversation, today: number): string {
  if (c.pinned) return 'Закреплённые';
  const age = Math.floor((today - startOfDay(new Date(c.updatedAt))) / DAY);
  if (age <= 0) return 'Сегодня';
  if (age === 1) return 'Вчера';
  if (age < 7) return 'На этой неделе';
  return 'Раньше';
}

function when(iso: string, today: number): string {
  const d = new Date(iso);
  const age = Math.floor((today - startOfDay(d)) / DAY);
  if (age <= 0) return tf.format(d);
  if (age === 1) return 'вчера';
  if (age < 7) return wf.format(d);
  return df.format(d);
}

function ChatRow({
  chat,
  index,
  today,
  onOpen,
  onMenu,
}: {
  chat: Conversation;
  index: number;
  today: number;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const summary = chat.kind === 'summary';
  const body = (
    <PressScale
      onPress={onOpen}
      onLongPress={onMenu}
      scale={0.985}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 12, borderRadius: radius.md }}
    >
      <View
        style={{
          width: 42,
          height: 42,
          borderRadius: 21,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: summary ? '#F2E3C8' : colors.surface2,
        }}
      >
        <Ionicons
          name={summary ? 'sunny' : 'chatbubble-ellipses'}
          size={19}
          color={summary ? colors.warn : colors.accent}
        />
      </View>
      <View style={{ flex: 1, marginLeft: space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {chat.pinned ? <Ionicons name="pin" size={12} color={colors.accent} style={{ marginRight: 5 }} /> : null}
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>
            {chat.title}
          </Text>
        </View>
        <Text style={{ color: colors.muted, fontSize: 14, marginTop: 2 }} numberOfLines={1}>
          {chat.preview ? plain(chat.preview) : 'Пустой чат'}
        </Text>
      </View>
      <Text style={{ color: colors.muted, fontSize: 12, marginLeft: space.sm }}>{when(chat.updatedAt, today)}</Text>
      <Pressable onPress={onMenu} hitSlop={8} accessibilityLabel="Действия с чатом" style={{ paddingLeft: 10, paddingVertical: 6 }}>
        <Ionicons name="ellipsis-horizontal" size={18} color={colors.muted} />
      </Pressable>
    </PressScale>
  );
  return index < 10 ? (
    <FadeIn delay={index * 35} distance={6}>
      {body}
    </FadeIn>
  ) : (
    body
  );
}

/** Архив тем: отдельные чаты, которые остались от прежней версии или создаются вручную («Новая тема»). */
export default function Chats() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ chat: Conversation; renaming: boolean; title: string } | null>(null);
  const { data, error, loading, refresh } = useLoad(async () => {
    const [chats, summaries] = await Promise.all([api.conversations('chat'), api.conversations('summary')]);
    return [...chats.conversations, ...summaries.conversations].sort(
      (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
    );
  });

  const today = startOfDay(new Date());
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const list = (data ?? []).filter((c) => !q || c.title.toLowerCase().includes(q) || (c.preview ?? '').toLowerCase().includes(q));
    const out: Row[] = [];
    let last = '';
    list.forEach((chat, index) => {
      const g = group(chat, today);
      if (g !== last) {
        out.push({ type: 'title', id: `t-${g}`, title: g });
        last = g;
      }
      out.push({ type: 'chat', id: chat.id, chat, index });
    });
    return out;
  }, [data, query, today]);

  const create = async () => {
    setCreating(true);
    try {
      const { conversation } = await api.createConversation();
      router.push(`/chat/${conversation.id}`);
    } catch (e) {
      notify('Не удалось создать тему', e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const fail = (e: unknown) => notify('Ошибка', e instanceof Error ? e.message : String(e));
  const pin = async (c: Conversation) => {
    setMenu(null);
    await api.pinConversation(c.id, !c.pinned).catch(fail);
    void refresh();
  };
  const rename = async () => {
    if (!menu || !menu.title.trim()) return;
    const { chat, title } = menu;
    setMenu(null);
    await api.renameConversation(chat.id, title.trim()).catch(fail);
    void refresh();
  };
  const remove = async (c: Conversation) => {
    setMenu(null);
    if (!(await confirmAction('Удалить чат?', c.title, 'Удалить'))) return;
    await api.deleteConversation(c.id).catch(fail);
    void refresh();
  };

  const count = data?.length ?? 0;
  return (
    <Screen edges={['left', 'right', 'bottom']}>
      <Header
        title="Архив тем"
        subtitle={count ? `Тем: ${count}. Основной разговор — на первой вкладке` : 'Отдельные темы вне основного разговора'}
        back
      />
      {loading && !data ? <Loading /> : null}
      <ErrorNote message={error} onRetry={refresh} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 110, flexGrow: 1, width: '100%', maxWidth: 760, alignSelf: 'center' }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        ListHeaderComponent={
          count > 2 ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginHorizontal: 12,
                marginTop: 4,
                marginBottom: 6,
                paddingHorizontal: 14,
                borderRadius: 22,
                backgroundColor: colors.surface2,
              }}
            >
              <Ionicons name="search" size={16} color={colors.muted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Поиск по чатам"
                placeholderTextColor={colors.muted}
                style={[{ flex: 1, color: colors.text, fontSize: 15, paddingVertical: 10, paddingHorizontal: 8 }, { outlineStyle: 'none' } as object]}
              />
              {query ? (
                <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Очистить поиск">
                  <Ionicons name="close-circle" size={17} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          !loading ? (
            query ? (
              <Empty icon="search-outline" text="Ничего не найдено" />
            ) : (
              <Empty icon="chatbubbles-outline" text="Здесь появятся отдельные темы. Обычно хватает основного разговора — Polaris помнит всё сам." />
            )
          ) : undefined
        }
        renderItem={({ item }) =>
          item.type === 'title' ? (
            <Text
              style={{
                color: colors.muted,
                fontSize: 12,
                fontWeight: '600',
                letterSpacing: 1,
                textTransform: 'uppercase',
                marginTop: 16,
                marginBottom: 2,
                marginLeft: 14,
              }}
            >
              {item.title}
            </Text>
          ) : (
            <ChatRow
              chat={item.chat}
              index={item.index}
              today={today}
              onOpen={() => router.push(`/chat/${item.chat.id}`)}
              onMenu={() => setMenu({ chat: item.chat, renaming: false, title: item.chat.title })}
            />
          )
        }
      />

      <FadeIn delay={250} distance={14} style={{ position: 'absolute', right: 20, bottom: 16 + insets.bottom }}>
        <PressScale
          onPress={creating ? undefined : create}
          accessibilityLabel="Новая тема"
          style={[
            {
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: 14,
              paddingHorizontal: 20,
              borderRadius: 28,
              backgroundColor: colors.ink,
              opacity: creating ? 0.6 : 1,
            },
            shadow,
          ]}
        >
          <Ionicons name="add" size={20} color={colors.accentText} />
          <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600', marginLeft: 6 }}>Новая тема</Text>
        </PressScale>
      </FadeIn>

      <Modal visible={menu !== null} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <Pressable
          onPress={() => setMenu(null)}
          style={{ flex: 1, backgroundColor: 'rgba(43,38,32,0.35)', justifyContent: 'flex-end', alignItems: 'center' }}
        >
          <Pressable
            onPress={() => undefined}
            style={{
              width: '100%',
              maxWidth: 520,
              backgroundColor: colors.surface,
              borderTopLeftRadius: 26,
              borderTopRightRadius: 26,
              padding: space.lg,
              paddingBottom: space.xl + insets.bottom,
            }}
          >
            <View style={{ alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: space.md }} />
            {menu?.renaming ? (
              <>
                <Input
                  label="Название чата"
                  value={menu.title}
                  onChangeText={(t) => setMenu({ ...menu, title: t })}
                  autoFocus
                  autoCapitalize="sentences"
                  autoCorrect
                  maxLength={200}
                  onSubmitEditing={rename}
                />
                <Button title="Сохранить" onPress={rename} disabled={!menu.title.trim()} />
              </>
            ) : menu ? (
              <>
                <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: 4 }} numberOfLines={1}>
                  {menu.chat.title}
                </Text>
                {(
                  [
                    { icon: menu.chat.pinned ? 'pin-outline' : 'pin', label: menu.chat.pinned ? 'Открепить' : 'Закрепить', run: () => pin(menu.chat), danger: false },
                    { icon: 'create-outline', label: 'Переименовать', run: () => setMenu({ ...menu, renaming: true }), danger: false },
                    { icon: 'trash-outline', label: 'Удалить', run: () => remove(menu.chat), danger: true },
                  ] as const
                ).map((o) => (
                  <PressScale
                    key={o.label}
                    onPress={() => void o.run()}
                    scale={0.985}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14 }}
                  >
                    <Ionicons name={o.icon} size={21} color={o.danger ? colors.danger : colors.text} />
                    <Text style={{ color: o.danger ? colors.danger : colors.text, fontSize: 16, marginLeft: space.md }}>{o.label}</Text>
                  </PressScale>
                ))}
              </>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}
