// Per-device "Recent searches" for food search — client-only (localStorage), never sent to
// the server. "Trending searches" (what OTHER customers search) is the server-side
// counterpart, powered by get_trending_food_searches().
const KEY = 'sndmart-recent-food-searches';
const MAX = 8;

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function getRecentFoodSearches(): string[] {
  return read();
}

export function addRecentFoodSearch(query: string): void {
  const q = query.trim();
  if (q.length < 2) return;
  try {
    const list = read().filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Private-browsing / storage blocked — recent searches just won't persist this session.
  }
}

export function clearRecentFoodSearches(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
