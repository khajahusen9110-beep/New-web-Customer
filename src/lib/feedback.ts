// Tactile feedback for taps: a short vibration (where the device supports it) and tiny
// synthesized sounds (Web Audio — no audio files to download). Sounds can be switched off
// from Profile; the choice is remembered on this device.

const PREF_KEY = 'sndmart-sounds';

export function soundsEnabled(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundsEnabled(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

let ctx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (!soundsEnabled()) return null;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One short sine/triangle note with a fast fade-out (no click at the end). */
function note(freq: number, startIn: number, length: number, volume: number, type: OscillatorType = 'sine', slideTo?: number) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + startIn;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + length);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(ac.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

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
    note(1500, 0, 0.035, 0.025, 'triangle');
  },
  /** Item added to cart: a soft rising "pop". */
  add() {
    vibrate(14);
    note(520, 0, 0.09, 0.08, 'sine', 880);
  },
  /** Item removed / quantity reduced: a soft falling note. */
  remove() {
    vibrate(10);
    note(620, 0, 0.08, 0.06, 'sine', 380);
  },
  /** Order placed: a three-note chime. */
  success() {
    vibrate([40, 60, 40, 60, 90]);
    note(659.25, 0, 0.16, 0.1);
    note(783.99, 0.12, 0.16, 0.1);
    note(1046.5, 0.24, 0.34, 0.11);
  },
  error() {
    vibrate([30, 40, 30]);
    note(240, 0, 0.14, 0.07, 'triangle', 180);
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
