import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../src/api';
import { ApprovalCard } from '../../src/ApprovalCard';
import { shorten } from '../../src/format';
import { useLoad } from '../../src/hooks';
import { useStatus } from '../../src/status';
import { colors, radius, space, toolLabel } from '../../src/theme';
import type { Approval, Message } from '../../src/types';
import { ErrorNote, Loading, notify } from '../../src/ui';

const STATUS_ICON = {
  ok: 'checkmark-circle',
  error: 'alert-circle',
  pending: 'time',
  rejected: 'close-circle',
} as const;
const STATUS_COLOR = {
  ok: colors.success,
  error: colors.danger,
  pending: colors.warn,
  rejected: colors.muted,
} as const;

function ToolRow({ m, approval, onResolved }: { m: Message; approval?: Approval; onResolved: () => void }) {
  const [open, setOpen] = useState(false);
  if (m.status === 'pending' && approval) return <ApprovalCard approval={approval} onResolved={onResolved} />;
  return (
    <Pressable onPress={() => setOpen(!open)} style={{ marginVertical: 3, maxWidth: '92%' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Ionicons name={STATUS_ICON[m.status]} size={16} color={STATUS_COLOR[m.status]} />
        <Text style={{ color: colors.muted, marginLeft: 6, fontSize: 13 }} numberOfLines={open ? undefined : 1}>
          {toolLabel(m.toolName ?? 'инструмент')}
          {m.content ? ` — ${open ? m.content : shorten(m.content, 90)}` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

function Bubble({ m }: { m: Message }) {
  const mine = m.role === 'user';
  if (!m.content && !m.toolCalls?.length) return null;
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginVertical: 4 }}>
      {m.content ? (
        <View
          style={{
            maxWidth: '90%',
            backgroundColor: mine ? colors.userBubble : m.status === 'error' ? '#3a1620' : colors.surface,
            borderRadius: radius.lg,
            borderBottomRightRadius: mine ? 4 : radius.lg,
            borderBottomLeftRadius: mine ? radius.lg : 4,
            paddingHorizontal: space.md,
            paddingVertical: 9,
            borderWidth: mine ? 0 : 1,
            borderColor: colors.border,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 16, lineHeight: 22 }} selectable>
            {m.content}
          </Text>
        </View>
      ) : null}
      {m.role === 'assistant' && m.provider ? (
        <Text style={{ color: colors.muted, fontSize: 11, marginTop: 2, marginLeft: 6 }}>
          {m.provider}
          {m.model ? ` · ${m.model}` : ''}
        </Text>
      ) : null}
    </View>
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
    (d) => (d?.running ? 1200 : d && d.pendingApprovals.length > 0 ? 4000 : undefined),
    [id],
  );

  const messages = data?.messages ?? [];
  const approvals = useMemo(() => new Map((data?.pendingApprovals ?? []).map((a) => [a.id, a])), [data]);
  const running = data?.running ?? false;
  const blocked = (data?.pendingApprovals.length ?? 0) > 0;

  useEffect(() => {
    if (messages.length !== lastCount.current) {
      lastCount.current = messages.length;
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 60);
    }
  }, [messages.length]);

  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
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
          contentContainerStyle={{ padding: space.lg, flexGrow: 1 }}
          ListEmptyComponent={
            !loading ? (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }}>
                <Ionicons name="sparkles" size={40} color={colors.accent} />
                <Text style={{ color: colors.muted, textAlign: 'center', marginTop: space.md }}>
                  Напишите, что нужно сделать. Polaris может искать в интернете, вести заметки, помнить факты и работать
                  в фоне.
                </Text>
              </View>
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
              <>
                <Bubble m={item} />
                {item.role === 'assistant' && item.toolCalls?.length ? (
                  <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 2 }}>
                    {item.toolCalls.map((c) => toolLabel(c.name)).join(', ')}…
                  </Text>
                ) : null}
              </>
            )
          }
          ListFooterComponent={
            running ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm }}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={{ color: colors.muted, marginLeft: space.sm }}>Polaris работает…</Text>
              </View>
            ) : undefined
          }
        />
        {blocked ? (
          <Text
            style={{
              color: colors.warn,
              textAlign: 'center',
              paddingHorizontal: space.lg,
              paddingBottom: 6,
              fontSize: 13,
            }}
          >
            Ждёт вашего решения — одобрите или отклоните действие выше.
          </Text>
        ) : null}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            padding: space.md,
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.surface,
          }}
        >
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Сообщение Polaris"
            placeholderTextColor={colors.muted}
            multiline
            editable={!blocked}
            onKeyPress={(e) => {
              const ev = e.nativeEvent as unknown as { key: string; shiftKey?: boolean };
              if (Platform.OS === 'web' && ev.key === 'Enter' && !ev.shiftKey) {
                (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                void send();
              }
            }}
            style={{
              flex: 1,
              maxHeight: 140,
              color: colors.text,
              backgroundColor: colors.surface2,
              borderRadius: radius.lg,
              paddingHorizontal: space.md,
              paddingTop: 10,
              paddingBottom: 10,
              fontSize: 16,
            }}
          />
          <Pressable
            onPress={send}
            disabled={!text.trim() || sending || running || blocked}
            accessibilityLabel="Отправить"
            style={{
              marginLeft: space.sm,
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.accent,
              opacity: !text.trim() || sending || running || blocked ? 0.4 : 1,
            }}
          >
            <Ionicons name="arrow-up" size={22} color={colors.accentText} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
