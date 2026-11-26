import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter, type Href } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Platform,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from './api';
import { useAuth } from './auth';
import { Dialog } from './Dialog';
import { useStatus } from './status';
import { colors, space } from './theme';
import type { Conversation } from './types';
import { Button, ErrorNote, Input, type HoverState, type IconName } from './ui';

interface WorkspaceValue {
  conversations: Conversation[];
  chatsLoading: boolean;
  chatsError: string | null;
  draftKey: number;
  sidebarVisible: boolean;
  toggleSidebar: () => void;
  newChat: () => void;
  refreshChats: () => Promise<void>;
  showChatMenu: (chat: Conversation) => void;
  clearChatState: () => void;
}
const Context = createContext<WorkspaceValue | null>(null);
export function useChatWorkspace(): WorkspaceValue {
  const value = useContext(Context);
  if (!value) throw new Error('ChatWorkspace отсутствует');
  return value;
}

function historyGroup(chat: Conversation): string {
  if (chat.pinned) return 'Закреплённые';
  const date = new Date(chat.updatedAt);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor(
    (today.getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000,
  );
  return days <= 0 ? 'Сегодня' : days === 1 ? 'Вчера' : days < 7 ? 'Последние 7 дней' : 'Ранее';
}

export function ChatWorkspace({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const { unread, approvals, refresh: refreshStatus } = useStatus();
  const router = useRouter();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [draftKey, setDraftKey] = useState(0);
  const [navigationKey, setNavigationKey] = useState(0);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{ chat: Conversation; mode: 'menu' | 'rename' | 'delete' } | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const visible = desktop ? !collapsed : drawer;

  const refreshChats = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.conversations(), api.conversations('summary')]);
      setChats(
        [...a.conversations, ...b.conversations].sort(
          (x, y) => Number(y.pinned) - Number(x.pinned) || y.updatedAt.localeCompare(x.updatedAt),
        ),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (state !== 'in') return;
    const first = setTimeout(() => void refreshChats(), 0);
    const timer = setInterval(() => void refreshChats(), 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [state, pathname, refreshChats]);

  const navigate = (path: Href) => {
    Keyboard.dismiss();
    setDrawer(false);
    router.push(path);
  };
  const newChat = () => {
    Keyboard.dismiss();
    setDrawer(false);
    setDraftKey((key) => key + 1);
    router.replace('/');
  };
  const clearChatState = () => {
    setChats([]);
    setQuery('');
    setMenu(null);
    newChat();
    setNavigationKey((key) => key + 1);
    void refreshChats();
    void refreshStatus();
  };
  const showChatMenu = (chat: Conversation) => {
    Keyboard.dismiss();
    setDrawer(false);
    setMenuError(null);
    setTitle(chat.title);
    setMenu({ chat, mode: 'menu' });
  };
  const mutate = async (action: () => Promise<unknown>, deleted = false) => {
    if (!menu || busy) return;
    setBusy(true);
    setMenuError(null);
    try {
      await action();
      if (deleted && pathname === `/chat/${menu.chat.id}`) newChat();
      if (deleted) setNavigationKey((key) => key + 1);
      setMenu(null);
      await refreshChats();
      void refreshStatus();
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('ru');
    return chats.filter((c) => !q || `${c.title} ${c.preview ?? ''}`.toLocaleLowerCase('ru').includes(q));
  }, [chats, query]);

  const navItem = (icon: IconName, label: string, path: Href, badge = 0) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => navigate(path)}
      style={({ hovered }: HoverState) => [s.nav, (pathname === path || hovered) && s.hover]}
    >
      <Ionicons name={icon} size={18} color={colors.text} />
      <Text style={s.navText}>{label}</Text>
      {badge > 0 ? <Text style={s.badge}>{badge}</Text> : null}
    </Pressable>
  );
  const sidebar = (
    <SafeAreaView
      edges={['top', 'bottom', 'left']}
      style={[s.sidebar, { width: desktop ? 268 : Math.min(310, width - 48) }]}
    >
      <View style={s.brandRow}>
        <Image source={require('../assets/icon.png')} style={{ width: 28, height: 28, borderRadius: 8, marginRight: 9 }} />
        <Text style={s.brand}>ChatGTT</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Скрыть боковую панель"
          onPress={() => (desktop ? setCollapsed(true) : setDrawer(false))}
          style={s.iconButton}
        >
          <Ionicons name="menu-outline" size={20} color={colors.muted} />
        </Pressable>
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={newChat}
        style={({ hovered }: HoverState) => [s.newChat, hovered && { backgroundColor: '#0E8F70' }]}
      >
        <Ionicons name="add" size={21} color={colors.accentText} />
        <Text style={{ color: colors.accentText, fontSize: 14, fontWeight: '600', marginLeft: 9 }}>Новый чат</Text>
        <Ionicons name="create-outline" size={17} color={colors.accentText} style={{ marginLeft: 'auto' }} />
      </Pressable>
      <View style={s.search}>
        <Ionicons name="search-outline" size={17} color={colors.muted} />
        <TextInput
          accessibilityLabel="Поиск чатов"
          placeholder="Поиск чатов"
          placeholderTextColor={colors.muted}
          value={query}
          onChangeText={setQuery}
          style={[s.searchInput, Platform.OS === 'web' && ({ outlineStyle: 'none' } as object)]}
        />
        {query ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Очистить поиск"
            onPress={() => setQuery('')}
            hitSlop={8}
          >
            <Ionicons name="close" size={15} color={colors.muted} />
          </Pressable>
        ) : null}
      </View>
      <View style={{ paddingHorizontal: 10, marginBottom: 12 }}>
        {navItem('checkbox-outline', 'Задачи', '/tasks', approvals)}
        {navItem('sparkles-outline', 'Память', '/memory')}
        {navItem('folder-outline', 'Файлы и заметки', '/more')}
      </View>
      <View style={{ height: 1, backgroundColor: colors.border, marginHorizontal: 20 }} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 10, paddingTop: 8, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? <ActivityIndicator color={colors.accent} style={{ padding: 20 }} /> : null}
        <ErrorNote message={error} onRetry={refreshChats} />
        {!loading && !error && !filtered.length ? (
          <View style={{ padding: 14, paddingTop: 24 }}>
            <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20 }}>
              {query ? 'Чаты не найдены' : 'Здесь будут ваши разговоры. Начните новый чат.'}
            </Text>
          </View>
        ) : null}
        {filtered.map((chat, index) => {
          const group = historyGroup(chat);
          const heading = !index || historyGroup(filtered[index - 1]!) !== group;
          const active = pathname === `/chat/${chat.id}`;
          return (
            <View key={chat.id}>
              {heading ? <Text style={s.group}>{group}</Text> : null}
              <View style={[s.chatRow, active && { backgroundColor: colors.userBubble }]}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Открыть чат: ${chat.title}`}
                  accessibilityState={{ selected: active }}
                  onPress={() => navigate(`/chat/${chat.id}`)}
                  style={({ hovered }: HoverState) => [s.chatLink, hovered && !active && s.hover]}
                >
                  <Text numberOfLines={1} style={{ color: colors.text, fontSize: 13, lineHeight: 20, flex: 1 }}>
                    {chat.title}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Действия с чатом: ${chat.title}`}
                  onPress={() => showChatMenu(chat)}
                  style={s.chatMenu}
                >
                  <Ionicons name="ellipsis-horizontal" size={17} color={colors.muted} />
                </Pressable>
              </View>
            </View>
          );
        })}
      </ScrollView>
      <View style={s.bottom}>
        {navItem('notifications-outline', 'Уведомления', '/inbox', unread)}
        {navItem('settings-outline', 'Настройки', '/settings')}
        <View style={s.profile}>
          <View style={s.avatar}>
            <Text style={{ color: colors.accent, fontWeight: '600', fontSize: 16 }}>P</Text>
          </View>
          <View style={{ marginLeft: 10 }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>Личное пространство</Text>
            <Text style={{ fontSize: 11, color: colors.muted, marginTop: 3 }}>Ваш помощник рядом</Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );

  return (
    <Context.Provider
      value={{
        conversations: chats,
        chatsLoading: loading,
        chatsError: error,
        draftKey,
        sidebarVisible: desktop && visible,
        toggleSidebar: () => (desktop ? setCollapsed((v) => !v) : setDrawer((v) => !v)),
        newChat,
        refreshChats,
        showChatMenu,
        clearChatState,
      }}
    >
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.bg }}>
        {state === 'in' && desktop && visible ? sidebar : null}
        <View key={`${state}-${navigationKey}`} style={{ flex: 1, minWidth: 0 }}>
          {children}
        </View>
      </View>
      {state === 'in' && !desktop ? (
        <Modal visible={drawer} transparent animationType="fade" onRequestClose={() => setDrawer(false)}>
          <View style={{ flex: 1, flexDirection: 'row', backgroundColor: 'rgba(43,38,32,0.3)' }}>
            {sidebar}
            <Pressable accessibilityLabel="Закрыть меню" onPress={() => setDrawer(false)} style={{ flex: 1 }} />
          </View>
        </Modal>
      ) : null}
      <Dialog
        visible={!!menu}
        title={
          menu?.mode === 'delete' ? 'Удалить чат?' : menu?.mode === 'rename' ? 'Переименовать чат' : 'Действия с чатом'
        }
        onClose={() => {
          if (!busy) setMenu(null);
        }}
      >
        <ErrorNote message={menuError} />
        {menu?.mode === 'menu' ? (
          <>
            <Text numberOfLines={2} style={{ fontSize: 14, color: colors.muted, marginBottom: space.md }}>
              {menu.chat.title}
            </Text>
            {(
              [
                { icon: 'create-outline', label: 'Переименовать', action: () => setMenu({ ...menu, mode: 'rename' }) },
                {
                  icon: 'pin-outline',
                  label: menu.chat.pinned ? 'Открепить' : 'Закрепить',
                  action: () => void mutate(() => api.pinConversation(menu.chat.id, !menu.chat.pinned)),
                },
                {
                  icon: 'trash-outline',
                  label: 'Удалить чат',
                  action: () => setMenu({ ...menu, mode: 'delete' }),
                  danger: true,
                },
              ] satisfies { icon: IconName; label: string; action: () => void; danger?: boolean }[]
            ).map((item) => (
              <Pressable
                key={item.label}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                disabled={busy}
                onPress={item.action}
                style={({ hovered }: HoverState) => [s.nav, hovered && s.hover, { paddingVertical: 14 }]}
              >
                <Ionicons name={item.icon} size={19} color={item.danger ? colors.danger : colors.text} />
                <Text style={[s.navText, item.danger && { color: colors.danger }]}>{item.label}</Text>
              </Pressable>
            ))}
          </>
        ) : menu?.mode === 'rename' ? (
          <>
            <Input
              accessibilityLabel="Название чата"
              value={title}
              onChangeText={setTitle}
              maxLength={200}
              autoFocus
              onSubmitEditing={() => {
                if (title.trim()) void mutate(() => api.renameConversation(menu.chat.id, title.trim()));
              }}
            />
            <Button
              title="Сохранить"
              disabled={!title.trim()}
              loading={busy}
              onPress={() => void mutate(() => api.renameConversation(menu.chat.id, title.trim()))}
            />
          </>
        ) : menu ? (
          <>
            <Text style={s.dialogText}>
              Чат «{menu.chat.title}», его сообщения и фотографии будут удалены без возможности восстановления.
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
              <Button title="Отмена" variant="secondary" disabled={busy} onPress={() => setMenu(null)} />
              <Button
                title="Удалить"
                variant="danger"
                loading={busy}
                onPress={() => void mutate(() => api.deleteConversation(menu.chat.id), true)}
              />
            </View>
          </>
        ) : null}
      </Dialog>
    </Context.Provider>
  );
}

const s = StyleSheet.create({
  sidebar: { height: '100%', backgroundColor: colors.sidebar, borderRightWidth: 1, borderRightColor: colors.border },
  brandRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 19, paddingBottom: 23 },
  brandStar: { color: colors.accent, fontSize: 30, marginRight: 9 },
  brand: { color: colors.text, fontSize: 21, fontWeight: '600', letterSpacing: -0.7, flex: 1 },
  iconButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  newChat: {
    marginHorizontal: 16,
    paddingHorizontal: 13,
    height: 43,
    borderRadius: 10,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 17,
    marginTop: 14,
    marginBottom: 10,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
  },
  searchInput: { flex: 1, minWidth: 0, color: colors.text, fontSize: 13, paddingVertical: 10, paddingHorizontal: 8 },
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 10,
  },
  navText: { fontSize: 13, color: colors.text, flex: 1 },
  hover: { backgroundColor: '#E5E5E5' },
  badge: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  group: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
    paddingHorizontal: 11,
    marginTop: 21,
    marginBottom: 9,
  },
  chatRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 8, marginBottom: 2, overflow: 'hidden' },
  chatLink: { flex: 1, minWidth: 0, paddingVertical: 10, paddingLeft: 11, paddingRight: 3 },
  chatMenu: { paddingHorizontal: 9, paddingVertical: 11 },
  bottom: { padding: 10, borderTopWidth: 1, borderTopColor: colors.border },
  profile: {
    marginTop: 12,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 16,
  },
  avatar: {
    width: 33,
    height: 33,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: '#CDEFE5',
  },
  dialogText: { color: colors.muted, fontSize: 14, lineHeight: 22, marginBottom: space.xl },
});
