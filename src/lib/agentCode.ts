const KEY = 'sndmart_pending_agent_code';

/**
 * Captures ?agent=CODE from the URL (an agent's shared link, e.g. sndmart.in/?agent=AG7K2M)
 * and stashes it in sessionStorage so it survives through the signup/login flow. Call this
 * once, as early as possible (module scope of main.tsx), before the router can touch the URL.
 */
export function captureAgentCodeFromUrl() {
  try {
    const code = new URLSearchParams(window.location.search).get('agent');
    if (code && code.trim()) sessionStorage.setItem(KEY, code.trim().toUpperCase());
  } catch {
    /* sessionStorage unavailable (private mode) — the manual "Agent code" field still works */
  }
}

export function takePendingAgentCode(): string | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (v) sessionStorage.removeItem(KEY);
    return v;
  } catch {
    return null;
  }
}
