import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { api } from '../../src/api';
import { ChatView } from '../../src/ChatView';
import { useLoad } from '../../src/hooks';

/** Отдельная тема из архива. Ссылки на главный разговор (из уведомлений) ведут на первую вкладку. */
export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data } = useLoad(() => api.main());
  const isMain = data?.conversation.id === id;
  useEffect(() => {
    if (isMain) router.replace('/');
  }, [isMain, router]);
  if (isMain) return null;
  return <ChatView key={id} id={id} />;
}
