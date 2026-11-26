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
import type { Conversation, Project } from './types';
import { FadeIn } from './motion';
import { Button, ErrorNote, Input, type HoverState, type IconName } from './ui';

interface WorkspaceValue {
  conversations: Conversation[];
  chatsLoading: boolean;
  chatsError: string | null;
  draftKey: number;
  /** Проект, в котором создастся новый чат (пока он черновик) */
  draftProjectId: string | null;
  projects: Project[];
  sidebarVisible: boolean;
  toggleSidebar: () => void;
  newChat: (projectId?: unknown) => void;
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
  return 'Недавние';
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
  const [draftProject, setDraftProject] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [projectDialog, setProjectDialog] = useState<{
    mode: 'create' | 'edit' | 'delete';
    project?: Project;
  } | null>(null);
  const [projectName, setProjectName] = useState('');
  const [projectInstructions, setProjectInstructions] = useState('');
  const [navigationKey, setNavigationKey] = useState(0);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<{ chat: Conversation; mode: 'menu' | 'rename' | 'delete' | 'move' } | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const visible = desktop ? !collapsed : drawer;

  const refreshChats = useCallback(async () => {
    try {
      const [a, b, p] = await Promise.all([api.conversations(), api.conversations('summary'), api.projects()]);
      setProjects(p.projects);
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
  const newChat = (projectId?: unknown) => {
    Keyboard.dismiss();
    setDrawer(false);
    setDraftProject(typeof projectId === 'string' ? projectId : null);
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

  const loose = useMemo(() => filtered.filter((c) => !c.projectId), [filtered]);

  const renderChat = (chat: Conversation) => {
    const active = pathname === `/chat/${chat.id}`;
    return (
      <View key={chat.id} style={[s.chatRow, active && { backgroundColor: colors.hover }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Открыть чат: ${chat.title}`}
          accessibilityState={{ selected: active }}
          onPress={() => navigate(`/chat/${chat.id}`)}
          style={({ hovered }: HoverState) => [s.chatLink, hovered && !active && s.hover]}
        >
          <Text numberOfLines={1} style={{ color: colors.text, fontSize: 14, lineHeight: 20, flex: 1 }}>
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
    );
  };

  const openProjectDialog = (mode: 'create' | 'edit', project?: Project) => {
    Keyboard.dismiss();
    setDrawer(false);
    setMenuError(null);
    setProjectName(project?.name ?? '');
    setProjectInstructions(project?.instructions ?? '');
    setProjectDialog({ mode, project });
  };
  const saveProject = async () => {
    if (!projectDialog || busy || !projectName.trim()) return;
    setBusy(true);
    setMenuError(null);
    try {
      if (projectDialog.mode === 'create') {
        const { project } = await api.createProject(projectName.trim(), projectInstructions.trim());
        setExpanded((prev) => new Set(prev).add(project.id));
      } else if (projectDialog.project) {
        await api.updateProject(projectDialog.project.id, {
          name: projectName.trim(),
          instructions: projectInstructions.trim(),
        });
      }
      setProjectDialog(null);
      await refreshChats();
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const removeProject = async () => {
    if (!projectDialog?.project || busy) return;
    setBusy(true);
    setMenuError(null);
    try {
      await api.deleteProject(projectDialog.project.id);
      if (draftProject === projectDialog.project.id) setDraftProject(null);
      setProjectDialog(null);
      await refreshChats();
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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
        <Image source={require('../assets/icon.png')} style={s.logo} />
        <Text style={s.brand}>ChatGTT</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Поиск чатов"
          onPress={() => {
            if (searchOpen) setQuery('');
            setSearchOpen((v) => !v);
          }}
          style={s.iconButton}
        >
          <Ionicons name="search-outline" size={19} color={colors.muted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Скрыть боковую панель"
          onPress={() => (desktop ? setCollapsed(true) : setDrawer(false))}
          style={s.iconButton}
        >
          <Ionicons name="reorder-two-outline" size={21} color={colors.muted} />
        </Pressable>
      </View>
      {searchOpen ? (
        <View style={s.search}>
          <Ionicons name="search-outline" size={17} color={colors.muted} />
          <TextInput
            accessibilityLabel="Поиск чатов"
            placeholder="Поиск чатов"
            placeholderTextColor={colors.muted}
            value={query}
            onChangeText={setQuery}
            autoFocus
            style={[s.searchInput, Platform.OS === 'web' && ({ outlineStyle: 'none' } as object)]}
          />
        </View>
      ) : null}
      <View style={{ paddingHorizontal: 10, marginBottom: 4 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Новый чат"
          onPress={newChat}
          style={({ hovered }: HoverState) => [s.nav, hovered && s.hover]}
        >
          <Ionicons name="create-outline" size={19} color={colors.text} />
          <Text style={s.navText}>Новый чат</Text>
        </Pressable>
      </View>
      <View style={{ paddingHorizontal: 10, marginBottom: 6 }}>
        {navItem('checkbox-outline', 'Задачи', '/tasks', approvals)}
        {navItem('sparkles-outline', 'Память', '/memory')}
        {navItem('folder-outline', 'Файлы и заметки', '/more')}
      </View>
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
        {projects.length || !query ? (
          <View>
            <View style={s.projectsHeader}>
              <Text style={[s.group, { marginTop: 18, marginBottom: 0, paddingHorizontal: 0, flex: 1 }]}>Проекты</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Новый проект"
                onPress={() => openProjectDialog('create')}
                style={s.iconButton}
              >
                <Ionicons name="add" size={20} color={colors.muted} />
              </Pressable>
            </View>
            {projects.map((project) => {
              const inside = filtered.filter((c) => c.projectId === project.id);
              if (query && !inside.length) return null;
              const open = expanded.has(project.id) || !!query;
              return (
                <FadeIn key={project.id} distance={4}>
                  <View style={s.chatRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Проект: ${project.name}`}
                      accessibilityState={{ expanded: open }}
                      onPress={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(project.id)) next.delete(project.id);
                          else next.add(project.id);
                          return next;
                        })
                      }
                      style={({ hovered }: HoverState) => [s.chatLink, s.projectLink, hovered && s.hover]}
                    >
                      <Ionicons name={open ? 'folder-open-outline' : 'folder-outline'} size={18} color={colors.text} />
                      <Text numberOfLines={1} style={{ color: colors.text, fontSize: 14, lineHeight: 20, flex: 1 }}>
                        {project.name}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Новый чат в проекте ${project.name}`}
                      onPress={() => {
                        setExpanded((prev) => new Set(prev).add(project.id));
                        newChat(project.id);
                      }}
                      style={s.chatMenu}
                    >
                      <Ionicons name="create-outline" size={17} color={colors.muted} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Действия с проектом ${project.name}`}
                      onPress={() => openProjectDialog('edit', project)}
                      style={s.chatMenu}
                    >
                      <Ionicons name="ellipsis-horizontal" size={17} color={colors.muted} />
                    </Pressable>
                  </View>
                  {open ? (
                    <View style={{ paddingLeft: 14 }}>
                      {inside.length ? (
                        inside.map((chat) => renderChat(chat))
                      ) : (
                        <Text style={{ color: colors.muted, fontSize: 12, paddingHorizontal: 11, paddingVertical: 6 }}>
                          В проекте пока нет чатов
                        </Text>
                      )}
                    </View>
                  ) : null}
                </FadeIn>
              );
            })}
            {!projects.length ? (
              <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 11, paddingTop: 6 }}>
                Проект — папка для чатов с общими инструкциями.
              </Text>
            ) : null}
          </View>
        ) : null}
        {loose.map((chat, index) => {
          const group = historyGroup(chat);
          const heading = !index || historyGroup(loose[index - 1]!) !== group;
          return (
            <FadeIn key={chat.id} delay={Math.min(index, 14) * 28} distance={6}>
              {heading ? <Text style={s.group}>{group}</Text> : null}
              {renderChat(chat)}
            </FadeIn>
          );
        })}
      </ScrollView>
      <View style={s.bottom}>
        {navItem('notifications-outline', 'Уведомления', '/inbox', unread)}
        {navItem('settings-outline', 'Настройки', '/settings')}
        <View style={s.profile}>
          <View style={s.avatar}>
            <Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 14 }}>C</Text>
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
        draftProjectId: draftProject,
        projects,
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
          <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.overlay }}>
            {sidebar}
            <Pressable accessibilityLabel="Закрыть меню" onPress={() => setDrawer(false)} style={{ flex: 1 }} />
          </View>
        </Modal>
      ) : null}
      <Dialog
        visible={!!menu}
        title={
          menu?.mode === 'delete'
            ? 'Удалить чат?'
            : menu?.mode === 'rename'
              ? 'Переименовать чат'
              : menu?.mode === 'move'
                ? 'Переместить в проект'
                : 'Действия с чатом'
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
                  icon: 'folder-outline',
                  label: menu.chat.projectId ? 'Переместить в другой проект' : 'В проект',
                  action: () => setMenu({ ...menu, mode: 'move' }),
                },
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
        ) : menu?.mode === 'move' ? (
          <>
            {menu.chat.projectId ? (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void mutate(() => api.moveConversation(menu.chat.id, null))}
                style={({ hovered }: HoverState) => [s.nav, hovered && s.hover, { paddingVertical: 14 }]}
              >
                <Ionicons name="close-circle-outline" size={19} color={colors.text} />
                <Text style={s.navText}>Убрать из проекта</Text>
              </Pressable>
            ) : null}
            {projects
              .filter((p) => p.id !== menu.chat.projectId)
              .map((p) => (
                <Pressable
                  key={p.id}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void mutate(() => api.moveConversation(menu.chat.id, p.id))}
                  style={({ hovered }: HoverState) => [s.nav, hovered && s.hover, { paddingVertical: 14 }]}
                >
                  <Ionicons name="folder-outline" size={19} color={colors.text} />
                  <Text numberOfLines={1} style={s.navText}>
                    {p.name}
                  </Text>
                </Pressable>
              ))}
            {!projects.length ? (
              <Text style={s.dialogText}>
                Проектов пока нет. Создайте проект кнопкой «+» рядом с заголовком «Проекты».
              </Text>
            ) : null}
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
      <Dialog
        visible={!!projectDialog}
        title={
          projectDialog?.mode === 'create'
            ? 'Новый проект'
            : projectDialog?.mode === 'delete'
              ? 'Удалить проект?'
              : 'Проект'
        }
        onClose={() => {
          if (!busy) setProjectDialog(null);
        }}
      >
        <ErrorNote message={menuError} />
        {projectDialog?.mode === 'delete' ? (
          <>
            <Text style={s.dialogText}>
              Проект «{projectDialog.project?.name}» будет удалён. Его чаты останутся и вернутся в общий список.
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
              <Button
                title="Отмена"
                variant="secondary"
                disabled={busy}
                onPress={() => setProjectDialog({ ...projectDialog, mode: 'edit' })}
              />
              <Button title="Удалить" variant="danger" loading={busy} onPress={() => void removeProject()} />
            </View>
          </>
        ) : projectDialog ? (
          <>
            <Input
              accessibilityLabel="Название проекта"
              value={projectName}
              onChangeText={setProjectName}
              placeholder="Название проекта"
              maxLength={120}
              autoFocus
            />
            <Input
              accessibilityLabel="Инструкции проекта"
              value={projectInstructions}
              onChangeText={setProjectInstructions}
              placeholder="Инструкции для чатов проекта (необязательно): тон, роль, правила, контекст"
              multiline
              maxLength={8000}
            />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              {projectDialog.mode === 'edit' ? (
                <Button
                  title="Удалить"
                  variant="ghost"
                  disabled={busy}
                  onPress={() => setProjectDialog({ ...projectDialog, mode: 'delete' })}
                />
              ) : (
                <View />
              )}
              <Button
                title={projectDialog.mode === 'create' ? 'Создать' : 'Сохранить'}
                disabled={!projectName.trim()}
                loading={busy}
                onPress={() => void saveProject()}
              />
            </View>
          </>
        ) : null}
      </Dialog>
    </Context.Provider>
  );
}

const s = StyleSheet.create({
  sidebar: { height: '100%', backgroundColor: colors.sidebar },
  brandRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 16, paddingBottom: 12 },
  brandStar: { color: colors.accent, fontSize: 30, marginRight: 9 },
  logo: { width: 30, height: 30, borderRadius: 9, marginRight: 10 },
  brand: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.3, flex: 1 },
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
    paddingVertical: 9,
    borderRadius: 10,
    gap: 10,
  },
  navText: { fontSize: 14, color: colors.text, flex: 1 },
  hover: { backgroundColor: colors.hover },
  badge: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  group: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 11,
    marginTop: 18,
    marginBottom: 6,
  },
  chatRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, marginBottom: 1, overflow: 'hidden' },
  chatLink: { flex: 1, minWidth: 0, paddingVertical: 10, paddingLeft: 11, paddingRight: 3 },
  projectsHeader: { flexDirection: 'row', alignItems: 'center', paddingLeft: 11, paddingRight: 4, marginTop: 4 },
  projectLink: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  chatMenu: { paddingHorizontal: 9, paddingVertical: 11 },
  bottom: { padding: 10 },
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
    backgroundColor: '#8B6B4A',
  },
  dialogText: { color: colors.muted, fontSize: 14, lineHeight: 22, marginBottom: space.xl },
});
