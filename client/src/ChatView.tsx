import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, attachmentSource } from './api';
import { ApprovalCard } from './ApprovalCard';
import type { Picked } from './attachments';
import { ChatComposer, type ComposerHandle } from './ChatComposer';
import { useChatWorkspace } from './ChatWorkspace';
import { Dialog } from './Dialog';
import { shorten } from './format';
import { IconButton } from './Header';
import { useLoad } from './hooks';
import { useKeyboardOpen } from './keyboard';
import { Markdown } from './Markdown';
import { FadeIn, PressScale, TypingDots } from './motion';
import { useStatus } from './status';
import { colors, radius, space, toolLabel } from './theme';
import type { Approval, Attachment, Message, SearchHit } from './types';
import { ErrorNote, Loading, type HoverState } from './ui';

const PAGE = 60;

const dayKey = (iso: string) => new Date(iso).toDateString();
const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const diff = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  return diff <= 0 ? 'Сегодня' : diff === 1 ? 'Вчера' : dayFmt.format(d);
}

/** Тонкая подпись дня между сообщениями. */
function DayChip({ iso }: { iso: string }) {
  return (
    <View style={{ alignItems: 'center', marginTop: space.lg, marginBottom: space.xs }}>
      <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.6 }}>
        {dayLabel(iso).toUpperCase()}
      </Text>
    </View>
  );
}

/** Метка в ленте: старая часть разговора сжата в сводку (память при этом остаётся). */
function CompactionNote() {
  return (
    <FadeIn style={{ flexDirection: 'row', alignItems: 'center', marginVertical: space.md }}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      <Text style={{ color: colors.muted, fontSize: 12, marginHorizontal: space.sm }}>✦ ранее — в сводке памяти</Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
    </FadeIn>
  );
}

const STATUS_ICON = {
  ok: 'checkmark',
  error: 'alert-circle-outline',
  pending: 'time-outline',
  rejected: 'close',
} as const;
const STATUS_COLOR = {
  ok: colors.success,
  error: colors.danger,
  pending: colors.warn,
  rejected: colors.muted,
} as const;

const SUGGESTIONS = [
  { icon: 'image-outline', label: 'Разобрать фото', prompt: 'Помоги разобраться с изображением. ' },
  { icon: 'globe-outline', label: 'Найти ответ', prompt: 'Помоги найти информацию: ' },
  { icon: 'create-outline', label: 'Написать текст', prompt: 'Помоги написать текст: ' },
  { icon: 'sunny-outline', label: 'Спланировать день', prompt: 'Помоги составить план на день. ' },
] as const;

const WIDE = { width: '100%', maxWidth: 760, alignSelf: 'center' } as const;

/** Служебные обёртки недоверенного содержимого (<web_content …>) пользователю ни к чему. */
const clean = (s: string) =>
  s
    .replace(/<\/?web_content[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function ToolRow({ m, approval, onResolved }: { m: Message; approval?: Approval; onResolved: () => void }) {
  const [open, setOpen] = useState(false);
  if (m.status === 'pending' && approval) return <ApprovalCard approval={approval} onResolved={onResolved} />;
  return (
    <FadeIn distance={4} style={{ marginVertical: 2, alignItems: 'flex-start' }}>
      <Pressable
        onPress={() => setOpen(!open)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          maxWidth: '94%',
          paddingVertical: 4,
          paddingHorizontal: 10,
          marginLeft: -10,
          borderRadius: 999,
          backgroundColor: open ? colors.surface2 : 'transparent',
        }}
      >
        <Ionicons name={STATUS_ICON[m.status]} size={14} color={STATUS_COLOR[m.status]} />
        <Text
          style={{ color: colors.muted, marginLeft: 6, fontSize: 13, flexShrink: 1 }}
          numberOfLines={open ? undefined : 1}
        >
          {toolLabel(m.toolName ?? 'инструмент')}
          {m.content ? ` · ${open ? clean(m.content) : shorten(clean(m.content), 80)}` : ''}
        </Text>
      </Pressable>
    </FadeIn>
  );
}

/** Строка в ленте: один или несколько подряд вызовов инструментов, свёрнутых в одну тихую строку. */
interface Row {
  id: string;
  first: Message;
  tools?: Message[];
}

const plural = (n: number) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'действие' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'действия' : 'действий'}`;

function ToolGroup({ items }: { items: Message[] }) {
  const [open, setOpen] = useState(false);
  const failed = items.some((m) => m.status === 'error' || m.status === 'rejected');
  const names = [...new Set(items.map((m) => toolLabel(m.toolName ?? 'инструмент')))];
  const one = items.length === 1 ? items[0]! : null;
  const title = one
    ? `${names[0]}${one.content ? ` · ${open ? clean(one.content) : shorten(clean(one.content), 70)}` : ''}`
    : `${plural(items.length)} · ${names.join(', ')}`;
  return (
    <FadeIn distance={4} style={{ marginVertical: 2, alignItems: 'flex-start' }}>
      <Pressable
        onPress={() => setOpen(!open)}
        style={{ flexDirection: 'row', alignItems: 'center', maxWidth: '96%', paddingVertical: 4, paddingRight: 8 }}
      >
        <Ionicons
          name={failed ? 'alert-circle-outline' : 'checkmark'}
          size={14}
          color={failed ? colors.danger : colors.success}
        />
        <Text
          style={{ color: colors.muted, marginLeft: 6, fontSize: 13, flexShrink: 1 }}
          numberOfLines={open && one ? undefined : 1}
        >
          {title}
        </Text>
        {!one ? (
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={12}
            color={colors.muted}
            style={{ marginLeft: 4 }}
          />
        ) : null}
      </Pressable>
      {open && !one ? (
        <View
          style={{
            marginLeft: 7,
            paddingLeft: 12,
            borderLeftWidth: 1,
            borderLeftColor: colors.border,
            marginVertical: 2,
          }}
        >
          {items.map((m) => (
            <Text
              key={m.id}
              style={{ color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 4 }}
              numberOfLines={4}
            >
              <Text style={{ fontWeight: '600' }}>{toolLabel(m.toolName ?? 'инструмент')}</Text>
              {m.content ? ` — ${clean(m.content)}` : ''}
            </Text>
          ))}
        </View>
      ) : null}
    </FadeIn>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Pressable
      accessibilityLabel="Копировать"
      hitSlop={8}
      onPress={async () => {
        await Clipboard.setStringAsync(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      style={{ padding: 4, marginLeft: -4 }}
    >
      <Ionicons name={done ? 'checkmark' : 'copy-outline'} size={15} color={done ? colors.success : colors.muted} />
    </Pressable>
  );
}

function Photos({ items, onOpen }: { items: Attachment[]; onOpen: (a: Attachment) => void }) {
  const size = items.length === 1 ? 220 : 120;
  return (
    <View
      style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '86%', marginBottom: 4 }}
    >
      {items.map((a) => (
        <PressScale key={a.id} scale={0.98} onPress={() => onOpen(a)} style={{ margin: 3 }}>
          <Image
            source={attachmentSource(a.id)}
            accessibilityLabel={a.name}
            style={{ width: size, height: size, borderRadius: radius.md, backgroundColor: colors.surface2 }}
            resizeMode="cover"
          />
        </PressScale>
      ))}
    </View>
  );
}

function Bubble({
  m,
  onOpen,
  onRegenerate,
  onEdit,
  isLast,
}: {
  m: Message;
  onOpen: (a: Attachment) => void;
  onRegenerate?: () => void;
  onEdit?: () => void;
  /** Последний ответ в ленте: только у него показываем «копировать» и «повторить», остальное — тишина. */
  isLast?: boolean;
}) {
  const mine = m.role === 'user';
  if (!m.content && !m.attachments?.length) return null;
  return (
    <FadeIn style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginVertical: space.sm }}>
      {mine && m.attachments?.length ? <Photos items={m.attachments} onOpen={onOpen} /> : null}
      {mine && !m.content ? null : mine ? (
        <View
          style={{
            maxWidth: '86%',
            backgroundColor: colors.userBubble,
            borderRadius: radius.lg,
            borderBottomRightRadius: 6,
            paddingHorizontal: space.lg,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 16, lineHeight: 23 }} selectable>
            {m.content}
          </Text>
        </View>
      ) : null}
      {mine && onEdit ? (
        <Pressable
          onPress={onEdit}
          hitSlop={8}
          accessibilityLabel="Изменить сообщение"
          style={{ padding: 4, marginTop: 2 }}
        >
          <Ionicons name="create-outline" size={15} color={colors.muted} />
        </Pressable>
      ) : null}
      {mine ? null : m.status === 'error' ? (
        <View style={{ backgroundColor: colors.dangerBg, borderRadius: radius.md, padding: space.md, maxWidth: '94%' }}>
          <Text style={{ color: colors.danger, fontSize: 15, lineHeight: 22 }} selectable>
            {m.content}
          </Text>
        </View>
      ) : (
        <View style={{ width: '100%' }}>
          <Markdown text={m.content} />
          {isLast ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <CopyButton text={m.content} />
              {onRegenerate ? (
                <Pressable
                  onPress={onRegenerate}
                  hitSlop={8}
                  accessibilityLabel="Повторить ответ"
                  style={{ padding: 4, marginLeft: 4 }}
                >
                  <Ionicons name="refresh-outline" size={16} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    </FadeIn>
  );
}

/** Плавно «допечатывает» текст до целевого: куски со стриминга приходят пачками, а глаз видит ровный поток. */
function useSmoothText(target: string): string {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown === target.length) return;
    const next =
      shown > target.length
        ? target.length
        : Math.min(target.length, shown + Math.max(1, Math.ceil((target.length - shown) / 8)));
    const t = setTimeout(() => setShown(next), shown > target.length ? 0 : 24);
    return () => clearTimeout(t);
  }, [target, shown]);
  return target.slice(0, Math.min(shown, target.length));
}

/** Independent conversations share the same thread view and composer. */
export function ChatView({ id: initialId }: { id?: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const workspace = useChatWorkspace();
  const { refresh: refreshStatus } = useStatus();
  const [id, setId] = useState(initialId);
  const store = useRef(new Map<string, Message>());
  const uploaded = useRef(new Map<string, string>());
  const composer = useRef<ComposerHandle>(null);
  const list = useRef<FlatList<Row>>(null);
  const atBottom = useRef(true);
  const initialising = useRef(true);
  const settled = useRef(false);
  const [exhausted, setExhausted] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ query: string; items: SearchHit[] } | null>(null);
  const [jump, setJump] = useState<number | null>(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const status = useLoad(() => api.status(), 30_000);
  const keyboardOpen = useKeyboardOpen();
  const { data, error, loading, refresh } = useLoad(
    async () => {
      if (!id)
        return {
          conversation: null,
          messages: [] as Message[],
          running: false,
          live: '',
          pendingApprovals: [] as Approval[],
        };
      const result = await api.conversation(id, { limit: PAGE });
      for (const message of result.messages) store.current.set(message.id, message);
      return { ...result, messages: [...store.current.values()].sort((a, b) => a.seq - b.seq) };
    },
    (result) => (result?.running ? 400 : id ? 15_000 : undefined),
    [id],
  );

  const messages = useMemo(() => data?.messages ?? [], [data]);
  const conversation = workspace.conversations.find((chat) => chat.id === id) ?? data?.conversation;
  const approvals = useMemo(() => new Map((data?.pendingApprovals ?? []).map((a) => [a.id, a])), [data]);
  const running = data?.running ?? false;
  const blocked = (data?.pendingApprovals.length ?? 0) > 0;
  const empty = !messages.length && !loading && !error;
  const needsLogin = !!status.data && !status.data.providers.some((provider) => provider.available);
  const liveText = useSmoothText(running ? (data?.live ?? '') : '');
  const rows = useMemo(() => {
    const result: Row[] = [];
    for (const message of messages) {
      const groupable =
        message.role === 'tool' &&
        !(message.status === 'pending' && message.approvalId && approvals.has(message.approvalId));
      const last = result[result.length - 1];
      if (groupable && last?.tools) last.tools.push(message);
      else
        result.push(
          groupable ? { id: message.id, first: message, tools: [message] } : { id: message.id, first: message },
        );
    }
    return result;
  }, [messages, approvals]);

  const toEnd = (animated: boolean) => {
    list.current?.scrollToEnd({ animated });
    if (Platform.OS === 'web') {
      const node = (
        list.current as unknown as { getScrollableNode?: () => HTMLElement | null } | null
      )?.getScrollableNode?.();
      if (node) node.scrollTop = node.scrollHeight;
    }
  };
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    if (lastId && atBottom.current) {
      const timer = setTimeout(() => toEnd(true), 60);
      return () => clearTimeout(timer);
    }
  }, [lastId]);
  const hasMessages = messages.length > 0;
  useEffect(() => {
    if (!hasMessages || settled.current) return;
    settled.current = true;
    const timers = [120, 400, 1000].map((ms) =>
      setTimeout(() => {
        if (atBottom.current) toEnd(false);
      }, ms),
    );
    timers.push(
      setTimeout(() => {
        initialising.current = false;
      }, 1100),
    );
    return () => timers.forEach(clearTimeout);
  }, [hasMessages]);
  useEffect(() => {
    if (liveText && atBottom.current) toEnd(false);
  }, [liveText]);

  const loadEarlier = async () => {
    if (!id || loadingMore || !store.current.size) return;
    setLoadingMore(true);
    try {
      const first = Math.min(...[...store.current.values()].map((m) => m.seq));
      const result = await api.conversation(id, { limit: PAGE, before: first });
      for (const message of result.messages) store.current.set(message.id, message);
      if (result.messages.length < PAGE) setExhausted(true);
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (!id || !searchOpen || query.trim().length < 2) return;
    let active = true;
    const timer = setTimeout(() => {
      api
        .searchConversation(id, query.trim())
        .then((result) => {
          if (active) setHits({ query: query.trim(), items: result.results });
        })
        .catch(() => {
          if (active) setHits({ query: query.trim(), items: [] });
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, searchOpen, query]);
  const openHit = async (hit: SearchHit) => {
    if (!id) return;
    setSearchOpen(false);
    atBottom.current = false;
    try {
      const result = await api.conversation(id, { limit: PAGE, before: hit.seq + 25 });
      for (const message of result.messages) store.current.set(message.id, message);
      await refresh();
      setJump(hit.seq);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (jump === null) return;
    const index = rows.findIndex((row) => row.first.seq === jump || row.tools?.some((tool) => tool.seq === jump));
    if (index < 0) return;
    const timer = setTimeout(() => {
      list.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true });
      setJump(null);
    }, 150);
    return () => clearTimeout(timer);
  }, [jump, rows]);

  const regenerate = async () => {
    if (!id) return;
    try {
      await api.regenerate(id);
      store.current.clear();
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };
  const editLast = async () => {
    if (!id) return;
    try {
      const result = await api.rewind(id);
      store.current.clear();
      await refresh();
      composer.current?.setText(result.content);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };
  const stop = async () => {
    if (!id) return;
    try {
      await api.stopConversation(id);
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };
  const send = async (content: string, files: Picked[]) => {
    setSending(true);
    setActionError(null);
    atBottom.current = true;
    try {
      const attachmentIds: string[] = [];
      for (const file of files) {
        let attachmentId = uploaded.current.get(file.key);
        if (!attachmentId) {
          attachmentId = (await api.uploadAttachment({ name: file.name, mime: file.mime, data: file.data })).attachment
            .id;
          uploaded.current.set(file.key, attachmentId);
        }
        attachmentIds.push(attachmentId);
      }
      const target = id ?? (await api.createConversation()).conversation.id;
      if (!id) setId(target);
      await api.sendMessage(target, content, attachmentIds);
      uploaded.current.clear();
      void workspace.refreshChats();
      if (!initialId) router.replace(`/chat/${target}`);
      else await refresh();
    } finally {
      setSending(false);
    }
  };
  const onResolved = () => {
    void refresh();
    void refreshStatus();
  };
  let doing = 'Думаю';
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      doing = toolLabel(message.toolCalls.at(-1)!.name);
      break;
    }
    if (message.role === 'user') break;
  }
  let lastUserId = '';
  let lastAssistantId = '';
  for (let index = messages.length - 1; index >= 0 && !lastUserId; index--) {
    const message = messages[index]!;
    if (message.role === 'user') lastUserId = message.id;
    else if (message.role === 'assistant' && message.content && !lastAssistantId) lastAssistantId = message.id;
  }
  const composerView = (
    <ChatComposer
      ref={composer}
      onSend={send}
      running={running}
      blocked={blocked}
      onStop={() => void stop()}
      draft={!initialId}
    />
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['bottom', 'left', 'right']}>
      <View
        style={{
          paddingTop: insets.top + 10,
          paddingBottom: 10,
          paddingHorizontal: 18,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {!workspace.sidebarVisible ? (
          <IconButton icon="menu-outline" label="Открыть меню" onPress={workspace.toggleSidebar} />
        ) : null}
        <Text style={{ color: colors.text, fontSize: 19, fontWeight: '600', letterSpacing: -0.5 }}>ChatGTT</Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ color: colors.muted, fontSize: 12, textAlign: 'center', paddingHorizontal: 12 }}
          >
            {conversation?.title ?? ''}
          </Text>
        </View>
        {id ? <IconButton icon="search-outline" label="Поиск в чате" onPress={() => setSearchOpen(true)} /> : null}
        {conversation ? (
          <IconButton
            icon="ellipsis-horizontal"
            label="Действия с текущим чатом"
            onPress={() => workspace.showChatMenu(conversation)}
          />
        ) : null}
        <IconButton icon="create-outline" label="Новый чат" onPress={workspace.newChat} />
      </View>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 62}
      >
        <ErrorNote message={error ?? actionError} onRetry={refresh} />
        {needsLogin ? (
          <View
            style={{
              ...WIDE,
              paddingHorizontal: 20,
              paddingVertical: 8,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Ionicons name="sparkles-outline" size={16} color={colors.accent} />
            <Text style={{ flex: 1, fontSize: 12, color: colors.muted, lineHeight: 18 }}>
              Подключите ChatGPT, чтобы начать разговор.
            </Text>
            <Pressable accessibilityRole="button" onPress={() => router.push('/settings')} style={{ padding: 8 }}>
              <Text style={{ color: colors.accent, fontSize: 12, fontWeight: '600' }}>Подключить</Text>
            </Pressable>
          </View>
        ) : null}
        {empty ? (
          <View style={{ flex: 1, justifyContent: 'center', paddingBottom: keyboardOpen ? 0 : 72 }}>
            <FadeIn style={{ alignItems: 'center', paddingHorizontal: 24, marginBottom: 23 }}>
              <Text
                style={{
                  color: colors.text,
                  fontSize: 28,
                  letterSpacing: -0.3,
                  textAlign: 'center',
                }}
              >
                Привет. Ну что, начнём?
              </Text>
            </FadeIn>
            <FadeIn delay={120} distance={14} duration={380}>
              {composerView}
            </FadeIn>
            {!keyboardOpen ? (
              <View
                style={{
                  ...WIDE,
                  flexDirection: 'row',
                  justifyContent: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                  paddingHorizontal: 24,
                  paddingTop: 15,
                }}
              >
                {SUGGESTIONS.map((suggestion, i) => (
                  <FadeIn key={suggestion.label} delay={320 + i * 70}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => composer.current?.setText(suggestion.prompt)}
                    style={({ hovered }: HoverState) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 7,
                      borderRadius: 20,
                      paddingHorizontal: 13,
                      paddingVertical: 9,
                      backgroundColor: hovered ? colors.surface2 : colors.chip,
                    })}
                  >
                    <Ionicons name={suggestion.icon} size={15} color={colors.muted} />
                    <Text style={{ fontSize: 12, color: colors.muted }}>{suggestion.label}</Text>
                  </Pressable>
                  </FadeIn>
                ))}
              </View>
            ) : null}
          </View>
        ) : (
          <>
            {loading && !data ? <Loading /> : null}
            <FlatList
              ref={list}
              data={rows}
              keyExtractor={(row) => row.id}
              style={{ flex: 1, width: '100%' }}
              scrollEventThrottle={64}
              onLayout={() => {
                if (atBottom.current) toEnd(false);
              }}
              onScroll={(event) => {
                if (initialising.current) return;
                const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                atBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 140;
              }}
              onContentSizeChange={() => {
                if (atBottom.current) toEnd(false);
              }}
              initialNumToRender={PAGE + 20}
              windowSize={31}
              maxToRenderPerBatch={PAGE}
              onScrollToIndexFailed={(info) =>
                list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })
              }
              contentContainerStyle={{ ...WIDE, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 30, flexGrow: 1 }}
              ListHeaderComponent={
                !exhausted && messages.length >= PAGE ? (
                  <PressScale onPress={loadEarlier} style={{ alignSelf: 'center', padding: 12 }}>
                    <Text style={{ color: colors.accent, fontSize: 13 }}>
                      {loadingMore ? 'Загружаю…' : 'Показать предыдущие сообщения'}
                    </Text>
                  </PressScale>
                ) : undefined
              }
              renderItem={({ item: row, index }) => {
                const item = row.first;
                const prev = rows[index - 1]?.first;
                return (
                  <>
                    {!prev || dayKey(prev.createdAt) !== dayKey(item.createdAt) ? (
                      <DayChip iso={item.createdAt} />
                    ) : null}
                    {row.tools ? (
                      <ToolGroup items={row.tools} />
                    ) : item.role === 'tool' ? (
                      <ToolRow
                        m={item}
                        approval={item.approvalId ? approvals.get(item.approvalId) : undefined}
                        onResolved={onResolved}
                      />
                    ) : item.role === 'system' ? (
                      item.toolName === 'compaction' ? (
                        <CompactionNote />
                      ) : null
                    ) : (
                      <Bubble
                        m={item}
                        onOpen={setViewing}
                        isLast={item.id === lastAssistantId}
                        onRegenerate={
                          item.id === lastAssistantId && !running && !blocked && !sending ? regenerate : undefined
                        }
                        onEdit={item.id === lastUserId && !running && !blocked && !sending ? editLast : undefined}
                      />
                    )}
                  </>
                );
              }}
              ListFooterComponent={
                running ? (
                  <View style={{ paddingVertical: space.sm }}>
                    {liveText ? <Markdown text={liveText} /> : null}
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm }}>
                      <TypingDots />
                      {!liveText ? (
                        <Text style={{ color: colors.muted, fontSize: 13, marginLeft: 10 }}>{doing}…</Text>
                      ) : null}
                    </View>
                  </View>
                ) : undefined
              }
            />
            {blocked ? (
              <Text style={{ color: colors.warn, textAlign: 'center', paddingHorizontal: 20, fontSize: 12 }}>
                Одобрите или отклоните действие выше, чтобы продолжить.
              </Text>
            ) : null}
            {composerView}
          </>
        )}
      </KeyboardAvoidingView>
      <Dialog visible={searchOpen} title="Поиск в чате" onClose={() => setSearchOpen(false)}>
        <TextInput
          accessibilityLabel="Искать в разговоре"
          value={query}
          onChangeText={setQuery}
          autoFocus
          placeholder="Введите хотя бы два символа"
          placeholderTextColor={colors.muted}
          style={[
            {
              backgroundColor: colors.surface2,
              color: colors.text,
              borderRadius: 10,
              padding: 12,
              fontSize: 14,
              marginBottom: 12,
            },
            Platform.OS === 'web' && ({ outlineStyle: 'none' } as object),
          ]}
        />
        <FlatList
          data={hits?.query === query.trim() ? hits.items : []}
          keyExtractor={(hit) => hit.id}
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: 360 }}
          ListEmptyComponent={
            <Text style={{ color: colors.muted, fontSize: 13, paddingVertical: 16, textAlign: 'center' }}>
              {query.trim().length < 2 ? 'Найдите сообщение в этом разговоре' : 'Ничего не найдено'}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => void openHit(item)} style={{ paddingVertical: 12 }}>
              <Text style={{ color: colors.accent, fontSize: 11, marginBottom: 4 }}>
                {item.role === 'user' ? 'Вы' : 'ChatGTT'} · {new Date(item.createdAt).toLocaleDateString('ru-RU')}
              </Text>
              <Text numberOfLines={3} style={{ color: colors.text, fontSize: 13, lineHeight: 20 }}>
                {item.snippet}
              </Text>
            </Pressable>
          )}
        />
      </Dialog>
      <Modal visible={!!viewing} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <Pressable
          accessibilityLabel="Закрыть фото"
          onPress={() => setViewing(null)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(30,25,18,0.9)',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          {viewing ? (
            <Image
              source={attachmentSource(viewing.id)}
              accessibilityLabel={viewing.name}
              resizeMode="contain"
              style={{ width: '100%', height: '100%' }}
            />
          ) : null}
          <View style={{ position: 'absolute', top: insets.top + 16, right: 20, padding: 8 }}>
            <Ionicons name="close" size={25} color={colors.accentText} />
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
