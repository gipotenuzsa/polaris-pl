import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Loading, Screen } from '../src/ui';

/** Цель «Поделиться» (PWA): текст и ссылка из другого приложения попадают в поле ввода главного разговора. */
export default function Share() {
  const { title, text, url } = useLocalSearchParams<{ title?: string; text?: string; url?: string }>();
  const router = useRouter();
  useEffect(() => {
    const parts = [title, text, url].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    try {
      if (parts.length) sessionStorage.setItem('polaris.share', parts.join('\n'));
    } catch {
      /* хранилище недоступно */
    }
    router.replace('/');
  }, [title, text, url, router]);
  return (
    <Screen>
      <Loading />
    </Screen>
  );
}
