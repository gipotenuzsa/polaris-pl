import { useRouter, useSegments } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as client from './api';

type State = 'loading' | 'out' | 'in';

interface AuthValue {
  state: State;
  signIn: (serverUrl: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AuthProvider отсутствует');
  return v;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('loading');
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    client.setUnauthorizedHandler(() => setState('out'));
    void client.restoreSession().then((ok) => setState(ok ? 'in' : 'out'));
    return () => client.setUnauthorizedHandler(null);
  }, []);

  // Защита маршрутов: без сессии — только экран входа
  const first = segments[0] as string | undefined;
  useEffect(() => {
    if (state === 'loading') return;
    if (state === 'out' && first !== 'login') router.replace('/login');
    if (state === 'in' && first === 'login') router.replace('/');
  }, [state, first, router]);

  const signIn = useCallback(async (serverUrl: string, password: string) => {
    await client.login(serverUrl, password);
    setState('in');
  }, []);

  const signOut = useCallback(async () => {
    await client.logout();
    setState('out');
  }, []);

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
