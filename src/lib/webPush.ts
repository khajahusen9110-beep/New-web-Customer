import { initializeApp, getApps, getApp } from 'firebase/app';
import { getMessaging, getToken, onMessage, deleteToken, Messaging } from 'firebase/messaging';
import { supabase } from './supabase';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
  storageBucket?: string;
  vapidKey: string;
}

const STORAGE_TOKEN_KEY = 'sndmart_fcm_token';
const STORAGE_DISMISSED_PROMPT_KEY = 'sndmart_notifications_prompt_dismissed';

function safeGetItem(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, val: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}

function safeRemoveItem(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getFirebaseConfig(): FirebaseWebConfig | null {
  const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined;
  const config: Partial<FirebaseWebConfig> = {
    apiKey: env?.VITE_FIREBASE_API_KEY || '',
    authDomain: env?.VITE_FIREBASE_AUTH_DOMAIN || '',
    projectId: env?.VITE_FIREBASE_PROJECT_ID || '',
    messagingSenderId: env?.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
    appId: env?.VITE_FIREBASE_APP_ID || '',
    storageBucket: env?.VITE_FIREBASE_STORAGE_BUCKET || '',
    vapidKey: env?.VITE_FIREBASE_VAPID_KEY || '',
  };
  if (config.apiKey && config.projectId && config.messagingSenderId && config.vapidKey) {
    return config as FirebaseWebConfig;
  }
  return null;
}

export function isFirebaseConfigured(): boolean {
  return getFirebaseConfig() !== null;
}

export function isNotificationSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export function getNotificationPermissionStatus(): NotificationPermission | 'unsupported' {
  if (!isNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

export function hasDismissedNotificationPrompt(): boolean {
  return safeGetItem(STORAGE_DISMISSED_PROMPT_KEY) === 'true';
}

export function setDismissedNotificationPrompt(dismissed: boolean): void {
  if (dismissed) safeSetItem(STORAGE_DISMISSED_PROMPT_KEY, 'true');
  else safeRemoveItem(STORAGE_DISMISSED_PROMPT_KEY);
}

let messagingInstance: Messaging | null = null;

function getClientMessaging(): Messaging | null {
  if (messagingInstance) return messagingInstance;
  if (!isNotificationSupported()) return null;
  const config = getFirebaseConfig();
  if (!config) return null;
  try {
    const app = getApps().length
      ? getApp()
      : initializeApp({
          apiKey: config.apiKey,
          authDomain: config.authDomain,
          projectId: config.projectId,
          messagingSenderId: config.messagingSenderId,
          appId: config.appId,
          storageBucket: config.storageBucket,
        });
    messagingInstance = getMessaging(app);
    return messagingInstance;
  } catch (e) {
    console.error('Failed to initialize Firebase Messaging:', e);
    return null;
  }
}

export interface EnableNotificationResult {
  success: boolean;
  token?: string;
  error?: 'unsupported' | 'missing_config' | 'denied' | 'registration_failed' | string;
  message?: string;
}

/**
 * Requests permission, registers the Service Worker with Firebase config, fetches the FCM
 * Web Push token, and upserts it to Supabase device_tokens for this logged-in customer.
 */
export async function enableNotifications(): Promise<EnableNotificationResult> {
  if (!isNotificationSupported()) {
    return { success: false, error: 'unsupported', message: 'Push notifications are not supported by this browser.' };
  }
  const config = getFirebaseConfig();
  if (!config) {
    return { success: false, error: 'missing_config', message: 'Push notifications are not configured yet.' };
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { success: false, error: 'denied', message: 'Notifications are disabled in browser settings.' };
    }

    const searchParams = new URLSearchParams({
      apiKey: config.apiKey,
      authDomain: config.authDomain || '',
      projectId: config.projectId,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId,
      storageBucket: config.storageBucket || '',
    });

    const registration = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?${searchParams.toString()}`);
    await navigator.serviceWorker.ready;
    if (registration.active) {
      registration.active.postMessage({ type: 'SET_FIREBASE_CONFIG', config });
    }

    const messaging = getClientMessaging();
    if (!messaging) throw new Error('Could not instantiate Firebase Messaging.');

    const token = await getToken(messaging, { vapidKey: config.vapidKey, serviceWorkerRegistration: registration });
    if (!token) throw new Error('No FCM registration token returned from Firebase.');

    safeSetItem(STORAGE_TOKEN_KEY, token);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { error: upsertErr } = await supabase
          .from('device_tokens')
          .upsert(
            { user_id: user.id, user_type: 'customer', fcm_token: token, active: true, firebase_project: 'native' },
            { onConflict: 'user_id,user_type' },
          );
        if (upsertErr) console.warn('Notice while upserting device token:', upsertErr.message || upsertErr);
      }
    } catch (dbErr) {
      console.warn('Exception during device_tokens upsert:', dbErr);
    }

    return { success: true, token, message: 'Push notifications are now active for this device!' };
  } catch (err: any) {
    console.error('Failed to enable notifications:', err);
    return { success: false, error: err?.code || 'registration_failed', message: err?.message || 'Failed to enable notifications.' };
  }
}

export async function disableNotifications(): Promise<{ success: boolean; message?: string }> {
  try {
    const messaging = getClientMessaging();
    if (messaging) {
      try {
        await deleteToken(messaging);
      } catch (delErr) {
        console.warn('Notice deleting FCM token:', delErr);
      }
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase.from('device_tokens').update({ active: false }).eq('user_id', user.id).eq('user_type', 'customer');
    }
    safeRemoveItem(STORAGE_TOKEN_KEY);
    return { success: true, message: 'Push notifications disabled for this device.' };
  } catch (err: any) {
    console.error('Failed to disable notifications:', err);
    return { success: false, message: err?.message || 'Failed to disable notifications.' };
  }
}

/** Shows the push via the browser's own notification UI when the tab is focused. */
export function setupForegroundPushListener(
  onForegroundMessage: (payload: { title: string; body: string; data?: any }) => void,
): (() => void) | null {
  const messaging = getClientMessaging();
  if (!messaging) return null;
  try {
    return onMessage(messaging, (payload) => {
      const title = payload.notification?.title || payload.data?.title || 'Sndmart';
      const body = payload.notification?.body || payload.data?.message || payload.data?.body || '';
      const data = payload.data || {};
      onForegroundMessage({ title, body, data });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('sndmart:push_notification', { detail: { title, body, data } }));
      }
      // Foreground messages don't auto-show a system notification — show one explicitly.
      if (Notification.permission === 'granted') {
        try {
          new Notification(title, { body, icon: '/icon-192.png' });
        } catch {
          /* ignore */
        }
      }
    });
  } catch (e) {
    console.warn('Failed to subscribe to foreground messages:', e);
    return null;
  }
}
