import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=in.sndmart.app';
const HIDE_FOR_MS = 7 * 24 * 60 * 60 * 1000;

// Separate keys so closing the card on the login page does not hide it after login.
const dismissKey = (loggedIn: boolean) => `sndmart-android-app-dismissed-at-${loggedIn ? 'user' : 'guest'}`;

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

function recentlyDismissed(loggedIn: boolean): boolean {
  try {
    const at = Number(localStorage.getItem(dismissKey(loggedIn)));
    return !!at && Date.now() - at < HIDE_FOR_MS;
  } catch {
    return false;
  }
}

/** Floating card inviting Android phone users to get the Sndmart app from the Play Store. */
export function AndroidAppPrompt({ loggedIn }: { loggedIn: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
    if (!isAndroid() || recentlyDismissed(loggedIn)) return;
    const t = window.setTimeout(() => setOpen(true), 2500);
    return () => window.clearTimeout(t);
  }, [loggedIn]);

  if (!open) return null;

  const dismiss = () => {
    setOpen(false);
    try {
      localStorage.setItem(dismissKey(loggedIn), String(Date.now()));
    } catch {
      // Storage unavailable (private mode): the card simply shows again next visit.
    }
  };

  return (
    <div className="install-card" role="dialog" aria-label="Get the Sndmart app">
      <button className="install-close" onClick={dismiss} aria-label="Close">
        <X size={18} />
      </button>
      <div className="install-top">
        <img src="/icon-192.png" alt="" className="install-icon" />
        <div>
          <div className="install-title">Get the Sndmart app</div>
          <div className="install-sub">Faster ordering and live order updates on your phone.</div>
        </div>
      </div>
      <a
        className="btn btn-primary install-ok"
        href={PLAY_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={dismiss}
      >
        Download from Play Store
      </a>
      <button className="install-later" onClick={dismiss}>
        Not now
      </button>
    </div>
  );
}
