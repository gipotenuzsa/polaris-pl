import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../src/api';
import { ApprovalCard } from '../../src/ApprovalCard';
import { shorten } from '../../src/format';
import { useLoad } from '../../src/hooks';
import { Markdown } from '../../src/Markdown';
import { FadeIn, PressScale, TypingDots } from '../../src/motion';
import { useStatus } from '../../src/status';
import { colors, radius, shadow, space, toolLabel } from '../../src/theme';
import type { Approval, Message } from '../../src/types';
import { ErrorNote, Loading, notify } from '../../src/ui';

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
          {m.content ? ` · ${open ? m.content : shorten(m.content, 80)}` : ''}
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

function Bubble({ m }: { m: Message }) {
  const mine = m.role === 'user';
  if (!m.content) return null;
  return (
    <FadeIn style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginVertical: space.sm }}>
      {mine ? (
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
      ) : m.status === 'error' ? (
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
            {m.model ? <Text style={{ color: colors.border, fontSize: 11, marginLeft: 6 }}>{m.model}</Text> : null}
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

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { refresh: refreshStatus } = useStatus();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const list = useRef<FlatList<Message>>(null);
  const lastCount = useRef(0);

  const { data, error, loading, refresh } = useLoad(
    () => api.conversation(id),
    // пока агент работает — опрашиваем часто, пока ждём подтверждения — реже
    (d) => (d?.running ? 400 : d && d.pendingApprovals.length > 0 ? 4000 : undefined),
    [id],
  );

  const messages = useMemo(() => data?.messages ?? [], [data]);
  const approvals = useMemo(() => new Map((data?.pendingApprovals ?? []).map((a) => [a.id, a])), [data]);
  const running = data?.running ?? false;
  const blocked = (data?.pendingApprovals.length ?? 0) > 0;
  const canSend = !!text.trim() && !sending && !running && !blocked;
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

  useEffect(() => {
    if (messages.length !== lastCount.current) {
      lastCount.current = messages.length;
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 60);
    }
  }, [messages.length]);

  useEffect(() => {
    if (liveText) list.current?.scrollToEnd({ animated: false });
  }, [liveText]);

  const send = async (override?: string) => {
    const content = (override ?? text).trim();
    if (!content || sending || running || blocked) return;
    setSending(true);
    setText('');
    try {
      await api.sendMessage(id, content);
      await refresh();
    } catch (e) {
      setText(content);
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
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['bottom', 'left', 'right']}>
      <Stack.Screen options={{ title: data?.conversation.title ?? 'Чат' }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={90}
      >
        {loading && !data ? <Loading /> : null}
        <ErrorNote message={error} onRetry={refresh} />
        <FlatList
          ref={list}
          data={messages}
          keyExtractor={(m) => m.id}
          style={WIDE}
          contentContainerStyle={{
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
                  Чем займёмся?
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
          renderItem={({ item }) =>
            item.role === 'tool' ? (
              <ToolRow
                m={item}
                approval={item.approvalId ? approvals.get(item.approvalId) : undefined}
                onResolved={onResolved}
              />
            ) : item.role === 'system' ? null : (
              <Bubble m={item} />
            )
          }
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
        <View style={[{ paddingHorizontal: space.md, paddingBottom: space.sm, paddingTop: 4 }, WIDE]}>
          <View
            style={[
              {
                flexDirection: 'row',
                alignItems: 'flex-end',
                backgroundColor: colors.surface,
                borderRadius: 26,
                borderWidth: 1,
                borderColor: colors.border,
                paddingLeft: space.lg,
                paddingRight: 6,
                paddingVertical: 6,
              },
              shadow,
            ]}
          >
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
                  paddingRight: space.sm,
                  fontSize: 16,
                },
                Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null,
              ]}
            />
            <SendButton enabled={canSend} running={running} onPress={() => (running ? void stop() : void send())} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
