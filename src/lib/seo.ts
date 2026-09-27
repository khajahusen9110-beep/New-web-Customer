import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const SITE_URL = ((import.meta.env.VITE_SITE_URL as string | undefined) || window.location.origin).replace(/\/+$/, '');
const DEFAULT_TITLE = 'Sndmart – Online Grocery, Fruits & Food Delivery in Sindhanur';

// [path prefix, page title]; first match wins. The login page (/auth) is the public landing page,
// so it keeps the full default title.
const TITLES: [string, string][] = [
  ['/onboarding', 'Set Delivery Location'],
  ['/cart', 'My Cart'],
  ['/checkout', 'Checkout'],
  ['/orders/', 'Order Details'],
  ['/orders', 'My Orders'],
  ['/profile/edit', 'Edit Profile'],
  ['/profile', 'My Profile'],
  ['/notifications', 'Notifications'],
  ['/wallet', 'Wallet'],
  ['/reviews', 'My Reviews'],
  ['/addresses', 'Saved Addresses'],
  ['/help', 'Help & Support'],
  ['/hotel/', 'Hotel Menu'],
];

// Pages anyone can open; the rest are personal and must not appear in search results.
const isPublic = (path: string) => path === '/' || path === '/auth';

function setMeta(selector: string, create: () => HTMLElement, attr: string, value: string) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = create();
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}

/** Keeps the page title, robots and canonical tags in sync with the current route. */
export function useRouteSeo() {
  const { pathname } = useLocation();
  useEffect(() => {
    const match = TITLES.find(([prefix]) => pathname.startsWith(prefix));
    document.title = match ? `${match[1]} | Sndmart` : DEFAULT_TITLE;

    setMeta(
      'meta[name="robots"]',
      () => Object.assign(document.createElement('meta'), { name: 'robots' }),
      'content',
      isPublic(pathname) ? 'index, follow' : 'noindex, nofollow',
    );
    // Guests on "/" land on /auth, so both point search engines at the home page.
    setMeta(
      'link[rel="canonical"]',
      () => Object.assign(document.createElement('link'), { rel: 'canonical' }),
      'href',
      `${SITE_URL}${isPublic(pathname) ? '/' : pathname}`,
    );
  }, [pathname]);
}
