import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from './api';
import { useAuth } from './auth';
import { colors, radius, space } from './theme';
import type { AppNotification } from './types';

interface StatusValue {
  unread: number;
  approvals: number;
  refresh: () => Promise<void>;
}

const Ctx = createContext<StatusValue>({ unread: 0, approvals: 0, refresh: async () => {} });
export const useStatus = () => useContext(Ctx);

const POLL_MS = 15_000;

/**
 * Опрашивает сервер (счётчики для значков вкладок) и показывает баннер о новых уведомлениях,
 * пока приложение открыто. Фоновые push на sideload-сборках iOS недоступны — см. README.
 */
export function StatusProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [counts, setCounts] = useState({ unread: 0, approvals: 0 });
  const [banner, setBanner] = useState<AppNotification | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const st = await api.status();
      setCounts({ unread: st.unreadNotifications, approvals: st.pendingApprovals });
      if (st.unreadNotifications > 0) {
        const { items } = await api.notifications();
        const unread = items.filter((n) => !n.read);
        if (seen.current === null) {
          seen.current = new Set(unread.map((n) => n.id)); // уведомления, накопленные до запуска, баннером не показываем
        } else {
          const fresh = unread.find((n) => !seen.current!.has(n.id));
          unread.forEach((n) => seen.current!.add(n.id));
          if (fresh) {
            setBanner(fresh);
            clearTimeout(hide.current);
            hide.current = setTimeout(() => setBanner(null), 7000);
          }
        }
      } else if (seen.current === null) {
        seen.current = new Set();
      }
    } catch {
      /* сервер временно недоступен */
    }
  }, []);

  useEffect(() => {
    if (state !== 'in') {
      seen.current = null;
      return;
    }
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [state, refresh]);

  const open = (n: AppNotification) => {
    setBanner(null);
    void api.markRead(n.id).then(refresh);
    if (n.ref?.conversationId && n.kind !== 'approval') router.push(`/chat/${n.ref.conversationId}`);
    else if (n.kind === 'approval') router.push('/approvals');
    else if (n.ref?.taskId) router.push(`/task/${n.ref.taskId}`);
    else router.push('/inbox');
  };

  const shown = state === 'in' ? counts : { unread: 0, approvals: 0 };
  const value = useMemo(() => ({ ...shown, refresh }), [shown.unread, shown.approvals, refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Ctx.Provider value={value}>
      {children}
      {banner ? (
        <Pressable onPress={() => open(banner)} style={[styles.banner, { top: insets.top + space.sm }]}>
          <Ionicons name="notifications" size={20} color={colors.accent} />
          <View style={{ flex: 1, marginLeft: space.md }}>
            <Text style={styles.bannerTitle} numberOfLines={1}>
              {banner.title}
            </Text>
            <Text style={styles.bannerBody} numberOfLines={2}>
              {banner.body}
            </Text>
          </View>
        </Pressable>
      ) : null}
    </Ctx.Provider>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface2,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
    zIndex: 100,
    maxWidth: 560,
    alignSelf: 'center',
  },
  bannerTitle: { color: colors.text, fontWeight: '700', fontSize: 14 },
  bannerBody: { color: colors.muted, fontSize: 13, marginTop: 2 },
});
