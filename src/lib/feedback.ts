// Tactile feedback for taps: a short vibration where the device supports it. No sounds.

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported (e.g. iPhone Safari) */
  }
}

export const feedback = {
  /** Any button tap: barely-there tick. */
  tap() {
    vibrate(8);
  },
  /** Item added to cart. */
  add() {
    vibrate(14);
  },
  /** Item removed / quantity reduced. */
  remove() {
    vibrate(10);
  },
  /** Order placed. */
  success() {
    vibrate([40, 60, 40, 60, 90]);
  },
  error() {
    vibrate([30, 40, 30]);
  },
};

/**
 * One listener for the whole app: every button / link press gets the light tap feedback,
 * unless the control handles its own (data-fb="none", e.g. the cart stepper's add/remove).
 */
export function installTapFeedback() {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const el = (e.target as Element | null)?.closest?.('button, a, [role="button"], [role="tab"]') as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled || el.closest('[data-fb="none"]')) return;
      feedback.tap();
    },
    { passive: true },
  );
}
