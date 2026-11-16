import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Gift, Headphones, Soup, Store } from 'lucide-react';
import { useSession } from '../store/session';
import { getTiffinConfig, type TiffinConfig } from '../lib/tiffin';
import { initialTiffinLang, saveTiffinLang, tt, type TiffinLang } from '../lib/tiffinI18n';
import { rupees } from '../lib/utils';

/**
 * First-visit tour: a few swipeable cards on what Sndmart offers, with Tiffin Pickup (when switched on for the
 * city) first and in most detail. Shown once per device; Profile > "App tour" opens it again.
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

type Slide = { key: string; Icon: typeof Store; title: string; body: string; tiffin?: 'intro' | 'trial' };

export function AppTour() {
  const navigate = useNavigate();
  const city = useSession((s) => s.selectedCity);
  const cityId = city?.id;
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<TiffinConfig | null>(null);
  const [lang, setLang] = useState<TiffinLang>(initialTiffinLang);
  const [i, setI] = useState(0);
  const askedFor = useRef<string | null>(null);

  const start = useCallback(
    async (force: boolean) => {
      if (!cityId) return;
      if (!force && (seen() || askedFor.current === cityId)) return;
      askedFor.current = cityId;
      let cfg: TiffinConfig | null = null;
      try {
        cfg = await getTiffinConfig(cityId);
      } catch {
        cfg = null;
      }
      setConfig(cfg?.enabled ? cfg : null);
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

  const tx = (key: string, ...a: (string | number)[]) => tt(lang, key, ...a);
  const days = config?.trial_days ?? 7;
  const trialPrice = rupees(config?.trial_price ?? 9);
  const slides: Slide[] = [
    { key: 'welcome', Icon: Store, title: tx('tourWelcomeT'), body: tx('tourWelcomeB') },
    ...(config
      ? ([
          { key: 'tiffin', Icon: Soup, title: tx('tourTiffinT'), body: tx('tourTiffinB'), tiffin: 'intro' },
          { key: 'trial', Icon: Soup, title: config.trial_enabled ? tx('tourTrialT', days, trialPrice) : tx('title'), body: config.trial_enabled ? tx('tourTrialB') : tx('heroSub'), tiffin: 'trial' },
        ] as Slide[])
      : []),
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
  const pickLang = (l: TiffinLang) => {
    saveTiffinLang(l);
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

        {slide.tiffin === 'intro' ? (
          <img className="tour-hero" src={config?.hero_image_url || '/tiffin/hero.jpg'} alt="" />
        ) : slide.tiffin === 'trial' ? (
          <div className="tour-steps">
            {['hw1', 'hw2', 'hw3', 'hw4'].map((k, n) => (
              <div key={k}>
                <span>{n + 1}</span>
                {tx(k)}
              </div>
            ))}
          </div>
        ) : (
          <div className="tour-icon">
            <slide.Icon size={54} />
          </div>
        )}

        <h2 className="tour-title">{slide.title}</h2>
        <p className="tour-body">{slide.body}</p>

        {slide.tiffin === 'trial' && (
          <button
            className="btn btn-outline w-full"
            onClick={() => {
              close();
              navigate('/tiffin');
            }}
          >
            {tx('tourTryTiffin')}
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
