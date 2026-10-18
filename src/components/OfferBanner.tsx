import { useEffect, useState } from 'react';
import { usePromoFor, type PromoKind } from '../lib/promo';

// A promo banner with a live countdown, shown only when an offer is active for the given section.
// All numbers (the %, the end time) come from the backend promo_campaigns via usePromoFor.

function parts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
}
const pad = (n: number) => String(n).padStart(2, '0');

export function OfferBanner({ kind }: { kind?: PromoKind }) {
  const food = usePromoFor('food');
  const grocery = usePromoFor('grocery');
  const promo = kind === 'food' ? food : kind === 'grocery' ? grocery : food || grocery;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!promo?.endsAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [promo?.endsAt]);

  if (!promo || promo.percent <= 0) return null;

  const isGrocery = kind === 'grocery' || (!kind && !food && !!grocery);
  const bg = isGrocery
    ? 'linear-gradient(135deg,#15803d,#166534)'
    : 'linear-gradient(135deg,#e11d48,#b91c3c)';
  const pct = Math.round(promo.percent);
  const title = promo.bannerNote || `${pct}% OFF`;

  const end = promo.endsAt ? Date.parse(promo.endsAt) : NaN;
  const show = !isNaN(end) && end > now;
  const p = show ? parts(end - now) : null;

  const cell = (v: string, l: string) => (
    <span style={{ background: '#fff', color: '#0f172a', borderRadius: 8, minWidth: 34, textAlign: 'center', padding: '3px 4px', lineHeight: 1.1 }}>
      <b style={{ display: 'block', fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>{v}</b>
      <i style={{ fontStyle: 'normal', fontSize: 9, opacity: 0.65 }}>{l}</i>
    </span>
  );

  return (
    <div style={{ borderRadius: 16, overflow: 'hidden', background: bg, color: '#fff', margin: '8px 0', boxShadow: '0 10px 24px -14px rgba(0,0,0,.4)' }}>
      <div style={{ padding: '12px 14px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.9 }}>
            {isGrocery ? 'SND Mart · Groceries Fest' : 'SND Mart · Food Fest'}
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, marginTop: 2 }}>{title}</div>
          <div style={{ fontSize: 12, opacity: 0.95, marginTop: 1 }}>ಇಂದೇ ಆರ್ಡರ್ ಮಾಡಿ · Order now</div>
        </div>
        <div style={{ fontSize: 30, fontWeight: 800, textShadow: '0 2px 10px rgba(0,0,0,.2)', whiteSpace: 'nowrap' }}>
          {pct}% <span style={{ fontSize: 14 }}>OFF</span>
        </div>
      </div>
      {p && (
        <div style={{ background: 'rgba(0,0,0,.22)', padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.95, lineHeight: 1.2 }}>
            ಆಫರ್ ಕೊನೆಯಾಗಲು<br />Ends in
          </span>
          <div style={{ display: 'flex', gap: 5 }}>
            {cell(String(p.d), 'ದಿನ')}
            {cell(pad(p.h), 'ಗಂ')}
            {cell(pad(p.m), 'ನಿ')}
            {cell(pad(p.s), 'ಸೆ')}
          </div>
        </div>
      )}
    </div>
  );
}

export default OfferBanner;
