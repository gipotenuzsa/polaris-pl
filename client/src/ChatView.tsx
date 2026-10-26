import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, attachmentSource } from './api';
import { ApprovalCard } from './ApprovalCard';
import { MAX_PICKS, pickImages, picksFromFiles, previewUri, type Picked } from './attachments';
import { shorten } from './format';
import { Header } from './Header';
import { useLoad } from './hooks';
import { useKeyboardOpen } from './keyboard';
import { Markdown } from './Markdown';
import { FadeIn, PressScale, TypingDots } from './motion';
import { useStatus } from './status';
import { colors, radius, shadow, space, toolLabel } from './theme';
import type { Approval, Attachment, Message, SearchHit } from './types';
import { Button, ErrorNote, Loading, notify } from './ui';

const PAGE = 60;

/** Минимальное описание Web Speech API (в TypeScript его типов нет). */
interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
}
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
      <Text style={{ color: colors.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.6 }}>{dayLabel(iso).toUpperCase()}</Text>
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
  'Что у меня на сегодня?',
  'Запомни: я люблю зелёный чай',
  'Найди свежие новости про ИИ',
  'Напомни через час размяться',
];

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
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '86%', marginBottom: 4 }}>
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
}: {
  m: Message;
  onOpen: (a: Attachment) => void;
  onRegenerate?: () => void;
  onEdit?: () => void;
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
        <Pressable onPress={onEdit} hitSlop={8} accessibilityLabel="Изменить сообщение" style={{ padding: 4, marginTop: 2 }}>
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
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <CopyButton text={m.content} />
            {onRegenerate ? (
              <Pressable onPress={onRegenerate} hitSlop={8} accessibilityLabel="Повторить ответ" style={{ padding: 4, marginLeft: 4 }}>
                <Ionicons name="refresh-outline" size={16} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>
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
    const next = shown > target.length ? target.length : Math.min(target.length, shown + Math.max(1, Math.ceil((target.length - shown) / 8)));
    const t = setTimeout(() => setShown(next), shown > target.length ? 0 : 24);
    return () => clearTimeout(t);
  }, [target, shown]);
  return target.slice(0, Math.min(shown, target.length));
}

function SendButton({
  enabled,
  running,
  onPress,
}: {
  enabled: boolean;
  running: boolean;
  onPress: () => void;
}) {
  const [v] = useState(() => new Animated.Value(enabled ? 1 : 0));
  useEffect(() => {
    Animated.spring(v, {
      toValue: enabled ? 1 : 0,
      speed: 24,
      bounciness: 6,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [enabled, v]);
  return (
    <PressScale
      onPress={enabled || running ? onPress : undefined}
      accessibilityLabel={running ? 'Остановить' : 'Отправить'}
      scale={0.9}
      style={{
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: enabled || running ? colors.ink : colors.surface2,
      }}
    >
      <Animated.View style={{ transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [2, 0] }) }] }}>
        {running ? (
          <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: colors.accentText }} />
        ) : (
          <Ionicons name="arrow-up" size={20} color={enabled ? colors.accentText : colors.muted} />
        )}
      </Animated.View>
    </PressScale>
  );
}

/** Лента разговора. `main` — единый сквозной разговор (главная вкладка); иначе — отдельная тема из архива. */
export function ChatView({ id, main = false }: { id: string; main?: boolean }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { refresh: refreshStatus, unread } = useStatus();
  const store = useRef(new Map<string, Message>());
  const [exhausted, setExhausted] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [jump, setJump] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRec | null>(null);
  const status = useLoad(() => (main ? api.status() : Promise.resolve(null)));
  const keyboardOpen = useKeyboardOpen();
  const [loadingMore, setLoadingMore] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [picks, setPicks] = useState<Picked[]>([]);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const list = useRef<FlatList<Message>>(null);
  const lastCount = useRef('');
  /** Пользователь у конца ленты: новые сообщения и стриминг подкручивают её вниз; если он листает вверх — не трогаем. */
  const atBottom = useRef(true);
  /** Прокрутка к концу ленты. На вебе scrollToEnd у FlatList бывает no-op при неизвестной высоте строк — дублируем прямой прокруткой DOM-узла. */
  const toEnd = (animated: boolean) => {
    const l = list.current;
    if (!l) return;
    l.scrollToEnd({ animated });
    if (Platform.OS === 'web') {
      const node = (l as unknown as { getScrollableNode?: () => HTMLElement | null }).getScrollableNode?.();
      if (node) node.scrollTop = node.scrollHeight;
    }
  };
  /** Первую секунду после загрузки события прокрутки не считаем действиями пользователя (лента ещё достраивается). */
  const initialising = useRef(true);
  const picksRef = useRef<Picked[]>([]);
  useEffect(() => {
    picksRef.current = picks;
  }, [picks]);

  const { data, error, loading, refresh } = useLoad(
    async () => {
      // Грузим только последнюю страницу и накапливаем её в памяти: длинный разговор не тянем целиком на каждом опросе.
      const d = await api.conversation(id, { limit: PAGE });
      for (const m of d.messages) store.current.set(m.id, m);
      return { ...d, messages: [...store.current.values()].sort((a, b) => a.seq - b.seq) };
    },
    // пока агент работает — опрашиваем часто, пока ждём подтверждения — реже; в главном разговоре подтягиваем и сообщения Polaris, пришедшие сами
    (d) => (d?.running ? 400 : d && d.pendingApprovals.length > 0 ? 4000 : main ? 15_000 : undefined),
    [id],
  );

  const loadEarlier = async () => {
    const first = store.current.size ? Math.min(...[...store.current.values()].map((m) => m.seq)) : 0;
    if (!first || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await api.conversation(id, { limit: PAGE, before: first });
      for (const m of d.messages) store.current.set(m.id, m);
      if (d.messages.length < PAGE) setExhausted(true);
      await refresh();
    } catch (e) {
      notify('Не удалось загрузить', e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const messages = useMemo(() => data?.messages ?? [], [data]);
  const approvals = useMemo(() => new Map((data?.pendingApprovals ?? []).map((a) => [a.id, a])), [data]);
  const running = data?.running ?? false;
  const blocked = (data?.pendingApprovals.length ?? 0) > 0;
  const canSend = (!!text.trim() || picks.length > 0) && !sending && !running && !blocked;
  const room = MAX_PICKS - picks.length;
  const needsLogin = main && !!status.data && !status.data.providers.some((p) => p.available);
  const speechOk =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  // Поиск по ленте с небольшой задержкой после ввода
  useEffect(() => {
    const q = query.trim();
    if (!searchOpen || q.length < 2) return;
    const t = setTimeout(() => {
      api
        .searchConversation(id, q)
        .then((r) => setHits(r.results))
        .catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query, searchOpen, id]);
  const shownHits = query.trim().length >= 2 ? hits : [];

  const openHit = async (h: SearchHit) => {
    setSearchOpen(false);
    atBottom.current = false; // идём к найденному месту, а не к концу
    try {
      const d = await api.conversation(id, { limit: PAGE, before: h.seq + 25 });
      for (const m of d.messages) store.current.set(m.id, m);
      await refresh();
      setJump(h.seq);
    } catch (e) {
      notify('Не удалось открыть', e instanceof Error ? e.message : String(e));
    }
  };

  const regenerate = async () => {
    try {
      store.current.clear();
      await api.regenerate(id);
      await refresh();
    } catch (e) {
      notify('Не удалось повторить', e instanceof Error ? e.message : String(e));
      await refresh();
    }
  };

  const editLast = async () => {
    try {
      const r = await api.rewind(id);
      store.current.clear();
      setText(r.content);
      await refresh();
    } catch (e) {
      notify('Не удалось изменить', e instanceof Error ? e.message : String(e));
    }
  };

  /** Диктовка голосом (веб: распознавание речи браузера). */
  const toggleMic = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.continuous = false;
    const base = text;
    rec.onresult = (e) => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i]![0]!.transcript;
      setText((base ? `${base} ` : '') + t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  // «Поделиться» в Polaris из другого приложения (PWA): текст попадает в поле ввода
  useEffect(() => {
    if (!main || Platform.OS !== 'web') return;
    try {
      const shared = sessionStorage.getItem('polaris.share');
      if (shared) {
        sessionStorage.removeItem('polaris.share');
        setTimeout(() => setText(shared), 0);
      }
    } catch {
      /* хранилище недоступно */
    }
  }, [main]);

  // Переход к найденному сообщению
  useEffect(() => {
    if (jump === null) return;
    const idx = messages.findIndex((m) => m.seq === jump);
    if (idx < 0) return;
    const t = setTimeout(() => {
      list.current?.scrollToIndex({ index: idx, viewPosition: 0.3, animated: true });
      setJump(null);
    }, 150);
    return () => clearTimeout(t);
  }, [jump, messages]);

  const addPicks = async (get: () => Promise<Picked[]>) => {
    try {
      const got = await get();
      if (got.length) setPicks((p) => [...p, ...got].slice(0, MAX_PICKS));
    } catch (e) {
      notify('Не удалось добавить фото', e instanceof Error ? e.message : String(e));
    }
  };

  // Вставка картинки из буфера обмена (веб): Ctrl+V со скриншотом или скопированным фото.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      void addPicks(() => picksFromFiles(files, MAX_PICKS - picksRef.current.length));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);
  const liveText = useSmoothText(running ? (data?.live ?? '') : '');

  const stop = async () => {
    try {
      await api.stopConversation(id);
      await refresh();
    } catch (e) {
      notify('Не удалось остановить', e instanceof Error ? e.message : String(e));
    }
  };

  // Что агент делает прямо сейчас — по последнему вызову инструмента.
  let doing = 'Думаю';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      doing = toolLabel(m.toolCalls[m.toolCalls.length - 1]!.name);
      break;
    }
    if (m.role === 'user') break;
  }

  let lastUserId = '';
  let lastAssistantId = '';
  for (let i = messages.length - 1; i >= 0 && !lastUserId; i--) {
    const m = messages[i]!;
    if (m.role === 'user') lastUserId = m.id;
    else if (m.role === 'assistant' && m.content && !lastAssistantId) lastAssistantId = m.id;
  }
  const lastId = messages.length ? messages[messages.length - 1]!.id : '';
  useEffect(() => {
    if (lastId !== lastCount.current) {
      lastCount.current = lastId;
      if (atBottom.current) setTimeout(() => toEnd(true), 60);
    }
  }, [lastId]);

  // После первой загрузки несколько раз подтверждаем «конец ленты»: разметка, формулы и картинки доезжают с задержкой.
  const settled = useRef(false);
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
        initialising.current = false; // дальше положение ленты определяет сам пользователь
      }, 1100),
    );
    return () => timers.forEach(clearTimeout);
  }, [hasMessages]);

  useEffect(() => {
    if (liveText && atBottom.current) toEnd(false);
  }, [liveText]);

  const send = async (override?: string) => {
    const content = (override ?? text).trim();
    const files = override ? [] : picks;
    if ((!content && files.length === 0) || sending || running || blocked) return;
    setSending(true);
    atBottom.current = true; // после отправки показываем конец ленты
    setText('');
    setPicks([]);
    try {
      const ids: string[] = [];
      for (const f of files) ids.push((await api.uploadAttachment({ name: f.name, mime: f.mime, data: f.data })).attachment.id);
      await api.sendMessage(id, content, ids);
      await refresh();
    } catch (e) {
      setText(content);
      setPicks(files);
      notify('Не отправлено', e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const onResolved = () => {
    void refresh();
    void refreshStatus();
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={main ? ['left', 'right'] : ['bottom', 'left', 'right']}>
      {main ? (
        <Header
          title="Polaris"
          subtitle={running ? `${doing}…` : 'Ваш личный агент'}
          actions={[
            { icon: 'search-outline', label: 'Поиск по разговору', onPress: () => setSearchOpen(true) },
            { icon: 'notifications-outline', label: 'Уведомления', badge: unread, onPress: () => router.push('/inbox') },
            { icon: 'settings-outline', label: 'Ещё', onPress: () => router.push('/more') },
          ]}
        />
      ) : (
        <Stack.Screen options={{ title: data?.conversation.title ?? 'Чат' }} />
      )}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={main ? insets.top + 72 : 90}
      >
        {loading && !data ? <Loading /> : null}
        <ErrorNote message={error} onRetry={refresh} />
        {needsLogin ? (
          <FadeIn style={{ marginHorizontal: space.lg, marginBottom: space.sm, ...WIDE, width: undefined }}>
            <View style={{ backgroundColor: colors.warnBg, borderRadius: radius.md, padding: space.lg }}>
              <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600', marginBottom: 4 }}>Осталось подключить ChatGPT</Text>
              <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: space.md }}>
                Polaris отвечает через вашу подписку ChatGPT. Вход занимает минуту: откроете ссылку, войдёте и вставите адрес из браузера.
              </Text>
              <Button title="Подключить" icon="log-in-outline" onPress={() => router.push('/settings')} />
            </View>
          </FadeIn>
        ) : null}
        <FlatList
          ref={list}
          data={messages}
          keyExtractor={(m) => m.id}
          style={{ width: '100%' }}
          scrollEventThrottle={64}
          onLayout={() => {
            if (atBottom.current) toEnd(false); // высота списка изменилась (баннер, клавиатура)
          }}
          onScroll={(e) => {
            if (initialising.current) return;
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            atBottom.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 160;
          }}
          // Контент ленты (разметка, формулы, картинки) дорисовывается после первого кадра: пока читаем конец, держим его на экране.
          // Так после перезапуска приложения лента открывается внизу, а не прыгает к началу.
          onContentSizeChange={() => {
            if (atBottom.current) toEnd(false);
          }}
          // Рендерим сразу всю загруженную страницу: иначе высота ленты оценивается приблизительно и «конец» оказывается не там.
          initialNumToRender={PAGE + 20}
          windowSize={31}
          maxToRenderPerBatch={PAGE}
          onScrollToIndexFailed={(info) => {
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
            setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.3, animated: true }), 400);
          }}
          ListHeaderComponent={
            !exhausted && messages.length >= PAGE ? (
              <PressScale onPress={loadEarlier} style={{ alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 16, marginBottom: space.sm }}>
                <Text style={{ color: colors.accent, fontSize: 14 }}>{loadingMore ? 'Загружаю…' : 'Показать ранее'}</Text>
              </PressScale>
            ) : undefined
          }
          contentContainerStyle={{
            ...WIDE,
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            paddingBottom: space.lg,
            flexGrow: 1,
          }}
          ListEmptyComponent={
            !loading ? (
              <FadeIn style={{ flex: 1, justifyContent: 'center', paddingBottom: space.xl * 2 }}>
                <Text style={{ color: colors.accent, fontSize: 26, marginBottom: space.sm }}>✦</Text>
                <Text style={{ color: colors.text, fontSize: 26, fontWeight: '600', letterSpacing: -0.5 }}>
                  {main ? 'Я рядом. С чего начнём?' : 'Чем займёмся?'}
                </Text>
                <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 6, marginBottom: space.xl }}>
                  Поиск, заметки, память и фоновые задачи — просто напишите.
                </Text>
                {SUGGESTIONS.map((q, i) => (
                  <FadeIn key={q} delay={120 + i * 70}>
                    <PressScale
                      onPress={() => void send(q)}
                      style={{
                        borderRadius: radius.md,
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.surface,
                        paddingVertical: 13,
                        paddingHorizontal: space.lg,
                        marginBottom: space.sm,
                      }}
                    >
                      <Text style={{ color: colors.text, fontSize: 15 }}>{q}</Text>
                    </PressScale>
                  </FadeIn>
                ))}
              </FadeIn>
            ) : undefined
          }
          renderItem={({ item, index }) => {
            const prev = messages[index - 1];
            const chip = !prev || dayKey(prev.createdAt) !== dayKey(item.createdAt) ? <DayChip iso={item.createdAt} /> : null;
            return (
              <>
                {chip}
                {item.role === 'tool' ? (
                  <ToolRow
                    m={item}
                    approval={item.approvalId ? approvals.get(item.approvalId) : undefined}
                    onResolved={onResolved}
                  />
                ) : item.role === 'system' ? (
                  item.toolName === 'compaction' ? <CompactionNote /> : null
                ) : (
                  <Bubble
                    m={item}
                    onOpen={setViewing}
                    onRegenerate={item.id === lastAssistantId && !running && !blocked && item.provider === 'chatgpt' ? regenerate : undefined}
                    onEdit={item.id === lastUserId && !running && !blocked ? editLast : undefined}
                  />
                )}
              </>
            );
          }}
          ListFooterComponent={
            running ? (
              <View style={{ paddingVertical: space.sm }}>
                {liveText ? <Markdown text={liveText} /> : null}
                <FadeIn distance={4} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm }}>
                  <TypingDots />
                  {liveText ? null : (
                    <Text style={{ color: colors.muted, marginLeft: space.sm, fontSize: 14 }}>{doing}…</Text>
                  )}
                </FadeIn>
              </View>
            ) : undefined
          }
        />
        {blocked ? (
          <Text
            style={{ color: colors.warn, textAlign: 'center', paddingHorizontal: space.lg, paddingBottom: 6, fontSize: 13 }}
          >
            Ждёт вашего решения — одобрите или отклоните действие выше.
          </Text>
        ) : null}
        <View style={[{ paddingHorizontal: space.md, paddingBottom: keyboardOpen ? 6 : space.xs, paddingTop: 4 }, WIDE]}>
          {picks.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 4, paddingBottom: space.sm }}>
              {picks.map((pk) => (
                <FadeIn key={pk.key} distance={4} style={{ marginRight: space.sm, marginBottom: 4 }}>
                  <Image source={{ uri: previewUri(pk) }} style={{ width: 64, height: 64, borderRadius: radius.sm }} />
                  <Pressable
                    accessibilityLabel="Убрать фото"
                    hitSlop={6}
                    onPress={() => setPicks((all) => all.filter((x) => x.key !== pk.key))}
                    style={{
                      position: 'absolute',
                      top: -6,
                      right: -6,
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      backgroundColor: colors.ink,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="close" size={13} color={colors.accentText} />
                  </Pressable>
                </FadeIn>
              ))}
            </View>
          ) : null}
          <View
            style={[
              {
                flexDirection: 'row',
                alignItems: 'flex-end',
                backgroundColor: colors.surface,
                borderRadius: 26,
                borderWidth: 1,
                borderColor: colors.border,
                paddingLeft: 6,
                paddingRight: 6,
                paddingVertical: 6,
              },
              shadow,
            ]}
          >
            <Pressable
              accessibilityLabel="Прикрепить фото"
              disabled={room <= 0 || blocked}
              onPress={() => void addPicks(() => pickImages(room))}
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: room <= 0 || blocked ? 0.35 : 1,
              }}
            >
              <Ionicons name="image-outline" size={22} color={colors.muted} />
            </Pressable>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Сообщение Polaris"
              placeholderTextColor={colors.muted}
              multiline
              numberOfLines={1}
              editable={!blocked}
              onKeyPress={(e) => {
                const ev = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
                if (Platform.OS === 'web' && ev.key === 'Enter' && !ev.shiftKey) {
                  (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                  void send();
                }
              }}
              style={[
                {
                  flex: 1,
                  maxHeight: 140,
                  color: colors.text,
                  paddingTop: 9,
                  paddingBottom: 9,
                  paddingLeft: 4,
                  paddingRight: space.sm,
                  fontSize: 16,
                },
                Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null,
              ]}
            />
            {speechOk && !running ? (
              <Pressable
                onPress={toggleMic}
                accessibilityLabel={listening ? 'Остановить диктовку' : 'Диктовать голосом'}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  marginRight: 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: listening ? colors.accent : 'transparent',
                }}
              >
                <Ionicons name={listening ? 'stop' : 'mic-outline'} size={20} color={listening ? colors.accentText : colors.muted} />
              </Pressable>
            ) : null}
            <SendButton enabled={canSend} running={running} onPress={() => (running ? void stop() : void send())} />
          </View>
        </View>
      </KeyboardAvoidingView>
      <Modal visible={searchOpen} transparent animationType="fade" onRequestClose={() => setSearchOpen(false)}>
        <Pressable onPress={() => setSearchOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(43,38,32,0.35)', alignItems: 'center' }}>
          <Pressable
            onPress={() => undefined}
            style={{
              width: '100%',
              maxWidth: 560,
              marginTop: insets.top + 56,
              marginHorizontal: space.lg,
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: space.md,
              maxHeight: '70%',
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface2, borderRadius: 22, paddingHorizontal: 14 }}>
              <Ionicons name="search" size={16} color={colors.muted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                autoFocus
                placeholder="Искать в разговоре"
                placeholderTextColor={colors.muted}
                style={[{ flex: 1, color: colors.text, fontSize: 15, paddingVertical: 11, paddingHorizontal: 8 }, { outlineStyle: 'none' } as object]}
              />
            </View>
            <FlatList
              data={shownHits}
              keyExtractor={(h) => h.id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text style={{ color: colors.muted, fontSize: 14, textAlign: 'center', padding: space.lg }}>
                  {query.trim().length < 2 ? 'Введите хотя бы два символа' : 'Ничего не найдено'}
                </Text>
              }
              renderItem={({ item: h }) => (
                <PressScale onPress={() => void openHit(h)} scale={0.985} style={{ paddingVertical: 10, paddingHorizontal: 6 }}>
                  <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 2 }}>
                    {h.role === 'user' ? 'Вы' : 'Polaris'} · {new Date(h.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </Text>
                  <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }} numberOfLines={3}>
                    {h.snippet}
                  </Text>
                </PressScale>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={!!viewing} transparent animationType="fade" onRequestClose={() => setViewing(null)}>
        <Pressable
          onPress={() => setViewing(null)}
          style={{ flex: 1, backgroundColor: 'rgba(30,25,18,0.88)', alignItems: 'center', justifyContent: 'center', padding: space.lg }}
        >
          {viewing ? (
            <Image
              source={attachmentSource(viewing.id)}
              accessibilityLabel={viewing.name}
              resizeMode="contain"
              style={{ width: '100%', height: '100%' }}
            />
          ) : null}
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}
