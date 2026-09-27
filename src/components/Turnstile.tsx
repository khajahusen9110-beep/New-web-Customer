import { useEffect, useRef } from 'react';

// Cloudflare Turnstile bot check for sending OTPs. The site key is public; the secret key lives
// only in Supabase (Authentication -> Attack Protection -> CAPTCHA), which verifies the token.
export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() || '';

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error('Could not load the security check'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/**
 * Renders the Turnstile widget and reports its token (null when expired/failed).
 * Tokens are single-use: change `resetKey` after each OTP request to get a fresh one.
 */
export function Turnstile({ onToken, resetKey }: { onToken: (token: string | null) => void; resetKey: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    cb.current(null);
    loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        widgetId = window.turnstile.render(ref.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action: 'send-otp',
          callback: (token: string) => cb.current(token),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => cb.current(null));
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [resetKey]);

  return <div ref={ref} className="turnstile-box" />;
}
