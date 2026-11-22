import { useEffect, useMemo, useState } from 'react';
import { buildStoreSlots, type StoreDeliveryCfg } from '../../lib/stores';

export interface StoreDeliveryChoice { type: 'express' | 'scheduled'; scheduledFor: string | null }

/** Express (as soon as possible) or Scheduled (a day + time window) for an order from a local shop. */
export function StoreDeliveryPicker({ cfg, shopOpen, value, onChange }: {
  cfg: StoreDeliveryCfg;
  shopOpen: boolean;
  value: StoreDeliveryChoice;
  onChange: (v: StoreDeliveryChoice) => void;
}) {
  const days = useMemo(() => buildStoreSlots(cfg), [cfg]);
  const [dayKey, setDayKey] = useState<string>(() => days[0]?.key ?? '');
  const canExpress = cfg.express_enabled && shopOpen;
  const canSchedule = cfg.scheduled_enabled && days.length > 0;

  // Keep the choice valid: if the current one is not possible, move to the one that is.
  useEffect(() => {
    if (value.type === 'express' && !canExpress && canSchedule) onChange({ type: 'scheduled', scheduledFor: null });
    if (value.type === 'scheduled' && !canSchedule && canExpress) onChange({ type: 'express', scheduledFor: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canExpress, canSchedule]);

  const day = days.find((d) => d.key === dayKey) ?? days[0];
  return (
    <section className="card pad store-delivery">
      <h3>Delivery</h3>
      <div className="row gap-8">
        {cfg.express_enabled && (
          <button type="button" className={`btn ${value.type === 'express' ? 'btn-primary' : 'btn-outline'}`} disabled={!canExpress}
            onClick={() => onChange({ type: 'express', scheduledFor: null })}>
            Express{cfg.express_extra_fee > 0 ? ` (+₹${cfg.express_extra_fee})` : ''}
          </button>
        )}
        {cfg.scheduled_enabled && (
          <button type="button" className={`btn ${value.type === 'scheduled' ? 'btn-primary' : 'btn-outline'}`} disabled={!canSchedule}
            onClick={() => onChange({ type: 'scheduled', scheduledFor: value.scheduledFor })}>
            Scheduled{cfg.scheduled_discount > 0 ? ` (₹${cfg.scheduled_discount} off)` : ''}
          </button>
        )}
      </div>
      {cfg.express_enabled && !shopOpen && <p className="muted small">The shop is closed right now. Choose a scheduled time. · ಅಂಗಡಿ ಈಗ ಮುಚ್ಚಿದೆ, ಸಮಯ ಆಯ್ಕೆಮಾಡಿ.</p>}
      {value.type === 'express' && canExpress && <p className="muted small">Delivered as soon as the shop packs it. · ಅಂಗಡಿ ಪ್ಯಾಕ್ ಮಾಡಿದ ತಕ್ಷಣ ಡೆಲಿವರಿ.</p>}
      {value.type === 'scheduled' && day && (
        <>
          <div className="row gap-8" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            {days.map((d) => (
              <button key={d.key} type="button" className={`chip ${d.key === day.key ? 'chip-on' : ''}`} onClick={() => { setDayKey(d.key); onChange({ type: 'scheduled', scheduledFor: null }); }}>
                {d.label}
              </button>
            ))}
          </div>
          <div className="row gap-8" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            {day.slots.map((sl) => (
              <button key={sl.startIso} type="button" className={`chip ${value.scheduledFor === sl.startIso ? 'chip-on' : ''}`} onClick={() => onChange({ type: 'scheduled', scheduledFor: sl.startIso })}>
                {sl.label}
              </button>
            ))}
          </div>
          {!value.scheduledFor && <p className="text-danger small">Pick a time window. · ಸಮಯ ಆಯ್ಕೆಮಾಡಿ.</p>}
        </>
      )}
    </section>
  );
}
