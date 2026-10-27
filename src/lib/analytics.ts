// Phase 1 analytics: lightweight, fire-and-forget session + page-view tracking for the
// Super Admin "Live Activity"/"Overview" dashboard. Never blocks or throws into the caller —
// every Supabase call here is wrapped so a slow/failed insert can't affect navigation, cart,
// or checkout. No PII beyond the authenticated user id (when logged in) is ever sent.
import { supabase } from './supabase';
import { useSession } from '../store/session';

const SESSION_KEY = 'sndmart_analytics_session_id';
const HEARTBEAT_MS = 60_000;

let sessionId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sessionStarted = false;

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getSessionId(): string {
  if (sessionId) return sessionId;
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) {
      sessionId = existing;
      return existing;
    }
  } catch {
    /* sessionStorage unavailable (private mode, SSR) — fall back to in-memory only */
  }
  const id = genId();
  sessionId = id;
  try {
    sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

/** Small, pragmatic UA parse — not a full device-detection library. */
function parseDevice(): { deviceType: string; browser: string | null; os: string | null } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const deviceType = /Mobi|Android/i.test(ua) ? 'mobile' : /Tablet|iPad/i.test(ua) ? 'tablet' : 'desktop';
  let browser: string | null = null;
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os: string | null = null;
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { deviceType, browser, os };
}

function trafficSource(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const utmSource = params.get('utm_source');
    if (utmSource) return utmSource;
    const ref = document.referrer;
    if (!ref) return 'direct';
    const host = new URL(ref).hostname;
    if (host === window.location.hostname) return null; // internal navigation, not a new source
    return host;
  } catch {
    return null;
  }
}

/** Call once near app bootstrap. Safe to call more than once — only initializes a session once. */
export function initAnalyticsSession(): void {
  if (sessionStarted) return;
  sessionStarted = true;
  const id = getSessionId();
  const { deviceType, browser, os } = parseDevice();
  const userId = useSession.getState().userId;

  supabase
    .from('analytics_sessions')
    .upsert(
      {
        id,
        user_id: userId,
        is_authenticated: Boolean(userId),
        device_type: deviceType,
        browser,
        os,
        entry_page: window.location.pathname,
        traffic_source: trafficSource(),
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'id', ignoreDuplicates: true },
    )
    .then(undefined, () => {});

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    sendHeartbeat();
  }, HEARTBEAT_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sendHeartbeat();
  });
}

function sendHeartbeat(): void {
  if (!sessionId) return;
  supabase
    .from('analytics_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', sessionId)
    .then(undefined, () => {});
}

/** Call on every route change. */
export function trackPageView(page: string): void {
  const id = getSessionId();
  const userId = useSession.getState().userId;
  supabase
    .from('analytics_events')
    .insert({ session_id: id, user_id: userId, event_name: 'page_view', page })
    .then(undefined, () => {});
  // A page view is also a sign of life — refresh last_seen_at without waiting for the next
  // heartbeat tick, so "Live Active Users" reacts promptly to real navigation.
  sendHeartbeat();
}
