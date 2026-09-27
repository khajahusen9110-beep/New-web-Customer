import { useEffect, useState } from 'react';
import { Share, SquarePlus, X } from 'lucide-react';

// Separate keys so closing the card on the login page does not hide it after login.
const dismissKey = (loggedIn: boolean) => `sndmart-ios-install-dismissed-at-${loggedIn ? 'user' : 'guest'}`;
const HIDE_FOR_MS = 7 * 24 * 60 * 60 * 1000;

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac, so also check for touch support.
  return /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.('(display-mode: standalone)').matches === true
  );
}

// Instagram, Facebook and similar in-app browsers cannot add to the Home Screen.
function isInAppBrowser(): boolean {
  return /FBAN|FBAV|Instagram|Line\/|Snapchat|GSA\//i.test(navigator.userAgent);
}

function recentlyDismissed(loggedIn: boolean): boolean {
  try {
    const at = Number(localStorage.getItem(dismissKey(loggedIn)));
    return !!at && Date.now() - at < HIDE_FOR_MS;
  } catch {
    return false;
  }
}

/** Floating card telling iPhone/iPad users how to install the site as an app (iOS has no install prompt). */
export function IosInstallPrompt({ loggedIn }: { loggedIn: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
    if (!isIos() || isStandalone() || recentlyDismissed(loggedIn)) return;
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

  const inApp = isInAppBrowser();

  return (
    <div className="install-card" role="dialog" aria-label="Install Sndmart app">
      <button className="install-close" onClick={dismiss} aria-label="Close">
        <X size={18} />
      </button>
      <div className="install-top">
        <img src="/apple-touch-icon.png" alt="" className="install-icon" />
        <div>
          <div className="install-title">Install the Sndmart app</div>
          <div className="install-sub">Faster ordering, right from your Home Screen.</div>
        </div>
      </div>
      {inApp ? (
        <div className="install-step">Open this page in Safari to add Sndmart to your Home Screen.</div>
      ) : (
        <ol className="install-steps">
          <li>
            Tap the <Share size={16} className="install-inline-icon" aria-label="Share" /> <b>Share</b> button in your browser
          </li>
          <li>
            Choose <SquarePlus size={16} className="install-inline-icon" aria-hidden /> <b>Add to Home Screen</b>
          </li>
        </ol>
      )}
      <button className="btn btn-primary install-ok" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
