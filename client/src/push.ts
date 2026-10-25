import { Platform } from 'react-native';
import { api } from './api';

/**
 * Web Push для PWA. На iPhone работает только у приложения, добавленного на экран «Домой» (iOS 16.4+);
 * в обычной вкладке Safari и в нативных сборках (там push не настроен) возможность недоступна.
 */
export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

const nav = (): Navigator | undefined => (Platform.OS === 'web' ? globalThis.navigator : undefined);

function isIos(): boolean {
  const n = nav();
  if (!n) return false;
  return /iPad|iPhone|iPod/.test(n.userAgent) || (n.platform === 'MacIntel' && n.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  const n = nav() as (Navigator & { standalone?: boolean }) | undefined;
  return Boolean(n?.standalone) || Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches);
}

function supported(): boolean {
  const n = nav();
  if (!n || /Electron/i.test(n.userAgent)) return false;
  return 'serviceWorker' in n && 'PushManager' in globalThis && 'Notification' in globalThis;
}

export function registerServiceWorker(): void {
  if (Platform.OS !== 'web' || !nav() || !('serviceWorker' in globalThis.navigator)) return;
  if (/Electron/i.test(globalThis.navigator.userAgent)) return;
  globalThis.navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await globalThis.navigator.serviceWorker.register('/sw.js');
  return globalThis.navigator.serviceWorker.ready;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !isStandalone() && nav() ? 'needs-install' : 'unsupported';
  if (isIos() && !isStandalone()) return 'needs-install';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await registration();
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Вызывать из обработчика нажатия кнопки: iOS требует жеста пользователя для запроса разрешения. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Разрешение на уведомления не выдано');
  const reg = await registration();
  const { publicKey } = await api.pushStatus();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('Браузер вернул неполную подписку');
  await api.pushSubscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
