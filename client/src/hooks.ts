import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Загружает данные при показе экрана и (необязательно) опрашивает сервер, пока экран на виду.
 * pollMs может быть функцией от текущих данных — например, «опрашивать часто, пока агент работает».
 * Опрос перезапускается после каждой загрузки (в том числе ручной refresh), поэтому, когда данные
 * показывают «агент работает», он включается сам.
 */
export function useLoad<T>(
  fn: () => Promise<T>,
  pollMs?: number | ((data: T | undefined) => number | undefined),
  deps: unknown[] = [],
): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const isFocused = useIsFocused();
  const fnRef = useRef(fn);
  const pollRef = useRef(pollMs);
  const dataRef = useRef<T | undefined>(undefined);
  // Свежие fn/pollMs подхватываются после каждого рендера, но не пересоздают подписки.
  useEffect(() => {
    fnRef.current = fn;
    pollRef.current = pollMs;
  });
  const depsKey = deps.map(String).join('|');

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    try {
      const d = await fnRef.current();
      dataRef.current = d;
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setVersion((v) => v + 1);
    }
  }, []);

  // Загрузка при каждом показе экрана (и при смене параметров)
  useFocusEffect(
    useCallback(() => {
      void load(dataRef.current !== undefined);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- depsKey перезапускает загрузку при смене параметров экрана
    }, [load, depsKey]),
  );

  // Следующий опрос планируется после каждой завершённой загрузки
  useEffect(() => {
    if (!isFocused) return;
    const p = pollRef.current;
    const ms = typeof p === 'function' ? p(dataRef.current) : p;
    if (!ms) return;
    const t = setTimeout(() => void load(true), ms);
    return () => clearTimeout(t);
  }, [isFocused, version, load]);

  const refresh = useCallback(() => load(true), [load]);
  return { data, error, loading, refresh };
}
