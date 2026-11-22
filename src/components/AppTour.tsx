import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Gift, HandHelping, Headphones, Store } from 'lucide-react';
import { useSession } from '../store/session';
import { getHelperConfig } from '../lib/helper';
import { initialTourLang, saveTourLang, tt, type TourLang } from '../lib/tourText';

/**
 * First-visit tour: a few swipeable cards on what Sndmart offers, with Quick Helper (when switched on for the
 * city). Shown once per device; Profile > "App tour" opens it again.
 */

const DONE_KEY = 'sndmart-tour-v1';
export const OPEN_TOUR_EVENT = 'sndmart-open-tour';

const seen = () => {
  try {
    return localStorage.getItem(DONE_KEY) === 'done';
  } catch {
    return false;
  }
};
const markSeen = () => {
  try {
    localStorage.setItem(DONE_KEY, 'done');
  } catch {
    /* private mode: it may show again next visit */
  }
};

type Slide = { key: string; Icon: typeof Store; title: string; body: string; helper?: boolean };

export function AppTour() {
  const navigate = useNavigate();
  const city = useSession((s) => s.selectedCity);
  const cityId = city?.id;
  const [open, setOpen] = useState(false);
  const [helperOn, setHelperOn] = useState(false);
  const [lang, setLang] = useState<TourLang>(initialTourLang);
  const [i, setI] = useState(0);
  const askedFor = useRef<string | null>(null);

  const start = useCallback(
    async (force: boolean) => {
      if (!cityId) return;
      if (!force && (seen() || askedFor.current === cityId)) return;
      askedFor.current = cityId;
      let on = false;
      try {
        on = (await getHelperConfig(cityId)).enabled === true;
      } catch {
        on = false;
      }
      setHelperOn(on);
      setI(0);
      setOpen(true);
    },
    [cityId],
  );

  useEffect(() => {
    void start(false);
  }, [start]);
  useEffect(() => {
    const onOpen = () => void start(true);
    window.addEventListener(OPEN_TOUR_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TOUR_EVENT, onOpen);
  }, [start]);

  const touchX = useRef<number | null>(null);
  if (!open) return null;

  const tx = (key: string) => tt(lang, key);
  const slides: Slide[] = [
    { key: 'welcome', Icon: Store, title: tx('tourWelcomeT'), body: tx('tourWelcomeB') },
    ...(helperOn ? ([{ key: 'helper', Icon: HandHelping, title: tx('tourHelperT'), body: tx('tourHelperB'), helper: true }] as Slide[]) : []),
    { key: 'wa', Icon: Headphones, title: tx('tourWaT'), body: tx('tourWaB') },
    { key: 'rewards', Icon: Gift, title: tx('tourRewardsT'), body: tx('tourRewardsB') },
  ];
  const last = i >= slides.length - 1;
  const slide = slides[Math.min(i, slides.length - 1)];

  const close = () => {
    markSeen();
    setOpen(false);
  };
  const next = () => (last ? close() : setI((n) => n + 1));
  const back = () => setI((n) => Math.max(0, n - 1));
  const pickLang = (l: TourLang) => {
    saveTourLang(l);
    setLang(l);
  };

  return (
    <div
      className="tour-overlay"
      role="dialog"
      aria-modal="true"
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (dx < -50) next();
        else if (dx > 50) back();
      }}
    >
      <div className="tour-card">
        <div className="tour-top">
          <div className="tour-lang">
            {(['en', 'kn'] as const).map((l) => (
              <button key={l} className={lang === l ? 'on' : ''} onClick={() => pickLang(l)}>
                {l === 'en' ? 'English' : 'ಕನ್ನಡ'}
              </button>
            ))}
          </div>
          {!last && (
            <button className="tour-skip" onClick={close}>
              {tx('tourSkip')}
            </button>
          )}
        </div>

        <div className="tour-icon">
          <slide.Icon size={54} />
        </div>

        <h2 className="tour-title">{slide.title}</h2>
        <p className="tour-body">{slide.body}</p>

        {slide.helper && (
          <button
            className="btn btn-outline w-full"
            onClick={() => {
              close();
              navigate('/helper');
            }}
          >
            {tx('tourTryHelper')}
          </button>
        )}

        <div className="tour-dots" aria-hidden="true">
          {slides.map((s, n) => (
            <i key={s.key} className={n === i ? 'on' : ''} />
          ))}
        </div>
        <button className="btn btn-primary btn-lg w-full" onClick={next}>
          {last ? tx('tourStart') : tx('tourNext')}
        </button>
      </div>
    </div>
  );
}
