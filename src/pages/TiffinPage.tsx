import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, CalendarDays, Camera, CheckCircle2, Clock, GraduationCap, Home, MapPin, Package, Pause, Phone, Play, Plus, Repeat } from 'lucide-react';
import { ErrorCard, ListSkeleton, PageHeader, Spinner, toast } from '../components/ui';
import { getAddresses } from '../lib/repository';
import {
  addDays,
  cancelTiffinRequest,
  createTiffinPlan,
  dayLabel,
  getMyTiffinPlans,
  getTiffinConfig,
  getTiffinPhotoUrl,
  getTiffinQuote,
  indiaToday,
  setTiffinDaySkipped,
  setTiffinPaused,
  timeLabel,
  upcomingPlanDays,
  type TiffinConfig,
  type TiffinKind,
  type TiffinQuote,
  type TiffinSubscription,
  type TiffinTrip,
} from '../lib/tiffin';
import type { CustomerAddress } from '../lib/types';
import { errorMessage, rupees } from '../lib/utils';
import { useSession } from '../store/session';

const WEEKDAYS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 7, label: 'Sun' },
];

const KINDS: { key: TiffinKind; label: string; Icon: typeof Home; who: string; detail: string }[] = [
  { key: 'school', label: 'School', Icon: GraduationCap, who: "Child's name", detail: 'Class and section' },
  { key: 'office', label: 'Office', Icon: Briefcase, who: "Person's name", detail: 'Department or desk (optional)' },
  { key: 'other', label: 'Other', Icon: Package, who: "Receiver's name", detail: 'Any detail to find them (optional)' },
];

const STATUS: Record<TiffinSubscription['status'], { label: string; cls: string }> = {
  pending_payment: { label: 'Waiting for payment', cls: 'tiffin-badge-warn' },
  active: { label: 'Active', cls: 'tiffin-badge-ok' },
  paused: { label: 'Paused', cls: 'tiffin-badge-muted' },
  completed: { label: 'Completed', cls: 'tiffin-badge-muted' },
  cancelled: { label: 'Cancelled', cls: 'tiffin-badge-muted' },
};

const TRIP_STATUS: Record<TiffinTrip['status'], string> = {
  scheduled: 'Scheduled',
  picked_up: 'Picked up, on the way',
  delivered: 'Delivered',
  missed: 'Missed',
  cancelled: 'Cancelled',
};

const addressText = (a: CustomerAddress) => `${a.label || 'Address'} — ${a.address_line}`;

export default function TiffinPage() {
  const navigate = useNavigate();
  const userId = useSession((s) => s.userId);
  const city = useSession((s) => s.selectedCity);
  const [config, setConfig] = useState<TiffinConfig | null>(null);
  const [plans, setPlans] = useState<TiffinSubscription[]>([]);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    if (!userId || !city?.id) return;
    setError(null);
    try {
      const [cfg, mine, addr] = await Promise.all([getTiffinConfig(city.id), getMyTiffinPlans().catch(() => []), getAddresses(userId, true)]);
      setConfig(cfg);
      setPlans(mine);
      setAddresses(addr);
      setShowForm((cur) => cur || mine.length === 0);
    } catch (e) {
      setError(errorMessage(e, 'Could not load Tiffin Pickup'));
    } finally {
      setLoading(false);
    }
  }, [userId, city?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const enabled = config?.enabled === true;

  return (
    <div className="page tiffin-page">
      <PageHeader title="Tiffin Pickup" subtitle="Home to school or office, every day" onBack={() => navigate('/')} />
      <div className="content-pad">
        {loading ? (
          <ListSkeleton count={3} height={120} />
        ) : error ? (
          <ErrorCard message={error} onRetry={() => void load()} />
        ) : (
          <>
            <section className="tiffin-hero">
              <div className="tiffin-hero-title">Your home food, delivered to them</div>
              <div className="tiffin-hero-sub">
                We collect the tiffin from your home and hand it over at the school or office, on the days you choose.
              </div>
              <div className="tiffin-hero-steps">
                <span>
                  <Home size={14} /> Pickup at home
                </span>
                <span>
                  <Camera size={14} /> Photo at handover
                </span>
                <span>
                  <CalendarDays size={14} /> Skip any day
                </span>
              </div>
            </section>

            {!enabled && plans.length === 0 && (
              <p className="muted center-pad">Tiffin Pickup is not available in {city?.name ?? 'your city'} yet.</p>
            )}

            {plans.map((p) => (
              <PlanCard key={p.id} plan={p} cutoffHour={config?.skip_cutoff_hour ?? 21} onChanged={load} />
            ))}

            {enabled && config && (
              <>
                {!showForm ? (
                  <button className="btn btn-outline w-full tiffin-new-btn" onClick={() => setShowForm(true)}>
                    <Plus size={18} /> Start a new tiffin plan
                  </button>
                ) : (
                  <NewPlanForm
                    config={config}
                    addresses={addresses}
                    canClose={plans.length > 0}
                    onClose={() => setShowForm(false)}
                    onCreated={async () => {
                      setShowForm(false);
                      await load();
                      window.scrollTo({ top: 0 });
                    }}
                  />
                )}
                <PriceTable config={config} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PriceTable({ config }: { config: TiffinConfig }) {
  return (
    <section className="card tiffin-card">
      <div className="tiffin-card-title">Monthly price</div>
      <div className="muted small">
        For a full month ({config.full_month_trips} days). Fewer days cost less. Distance is measured straight from home to the drop point.
      </div>
      <div className="tiffin-price-rows">
        {config.slabs.map((s, i) => (
          <div key={i} className="tiffin-price-row">
            <span>Up to {s.up_to_km} km</span>
            <span>
              <strong>{rupees(s.price)}</strong>
              <span className="muted small"> · box return +{rupees(s.return_price)}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlanCard({ plan, cutoffHour, onChanged }: { plan: TiffinSubscription; cutoffHour: number; onChanged: () => Promise<void> | void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const today = indiaToday();
  const todays = plan.trips.filter((t) => t.trip_date === today);
  const running = plan.status === 'active' || plan.status === 'paused';
  const upcoming = useMemo(() => (running ? upcomingPlanDays(plan, 7) : []), [plan, running]);
  const kind = KINDS.find((k) => k.key === plan.kind) ?? KINDS[0];

  const run = async (key: string, fn: () => Promise<void>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast(done);
      await onChanged();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const openPhoto = async (path: string) => {
    const url = await getTiffinPhotoUrl(path);
    if (url) window.open(url, '_blank', 'noopener');
    else toast('Could not open the photo');
  };

  return (
    <section className="card tiffin-card">
      <div className="row between gap-8">
        <div className="tiffin-plan-who">
          <span className="tiffin-kind-icon">
            <kind.Icon size={18} />
          </span>
          <div>
            <strong>{plan.recipient_name}</strong>
            {plan.recipient_detail && <div className="muted small">{plan.recipient_detail}</div>}
          </div>
        </div>
        <span className={`tiffin-badge ${STATUS[plan.status].cls}`}>{STATUS[plan.status].label}</span>
      </div>

      <div className="tiffin-route">
        <div>
          <Home size={14} /> <span>{plan.pickup_address}</span>
        </div>
        <div>
          <MapPin size={14} /> <span>{plan.drop_label ? `${plan.drop_label} — ` : ''}{plan.drop_address}</span>
        </div>
        <div>
          <Clock size={14} />{' '}
          <span>
            Pickup {timeLabel(plan.pickup_time)} · {WEEKDAYS.filter((d) => plan.days.includes(d.n)).map((d) => d.label).join(', ')}
          </span>
        </div>
        {plan.return_trip && (
          <div>
            <Repeat size={14} /> <span>Empty box comes back, collected at {timeLabel(plan.return_pickup_time)}</span>
          </div>
        )}
      </div>

      {plan.status === 'pending_payment' && (
        <div className="tiffin-note tiffin-note-warn">
          <strong>{rupees(plan.total_amount)}</strong> for {plan.trips_total} days, starting {dayLabel(plan.start_date)}. Our team will
          contact you to collect the payment, and the plan starts after that.
          <div className="mt-8">
            <button
              className="btn btn-sm btn-outline"
              disabled={busy !== null}
              onClick={() => run('cancel', () => cancelTiffinRequest(plan.id), 'Request cancelled')}
            >
              {busy === 'cancel' ? <Spinner size={16} /> : 'Cancel request'}
            </button>
          </div>
        </div>
      )}

      {running && (
        <>
          <div className="tiffin-stats">
            <div>
              <strong>{plan.trips_remaining}</strong>
              <span>days left</span>
            </div>
            <div>
              <strong>{plan.trips_total}</strong>
              <span>days in plan</span>
            </div>
            <div>
              <strong>{dayLabel(plan.end_date)}</strong>
              <span>use before</span>
            </div>
          </div>

          {plan.partner ? (
            <div className="tiffin-partner">
              <span>
                Delivery partner: <strong>{plan.partner.name}</strong>
              </span>
              {plan.partner.phone && (
                <a className="btn btn-sm btn-outline" href={`tel:${plan.partner.phone}`}>
                  <Phone size={14} /> Call
                </a>
              )}
            </div>
          ) : (
            <div className="muted small">A delivery partner will be assigned before the first day.</div>
          )}

          {todays.length > 0 && (
            <div className="tiffin-today">
              <div className="label-caps">Today</div>
              {todays.map((t) => (
                <div key={t.id} className="tiffin-today-row">
                  <span>
                    {t.status === 'delivered' && <CheckCircle2 size={15} className="text-success" />}{' '}
                    {t.leg === 'drop' ? 'Tiffin' : 'Box return'} · {TRIP_STATUS[t.status]}
                    {t.status === 'scheduled' && ` for ${timeLabel(t.scheduled_time)}`}
                  </span>
                  {t.delivered_photo_url && (
                    <button className="btn btn-sm btn-text" onClick={() => void openPhoto(t.delivered_photo_url!)}>
                      <Camera size={14} /> Photo
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {plan.status === 'active' && upcoming.length > 0 && (
            <div className="tiffin-days">
              <div className="label-caps">Coming days — tap to skip</div>
              <div className="tiffin-day-chips">
                {upcoming.map((d) => {
                  const skipped = plan.skips.includes(d);
                  return (
                    <button
                      key={d}
                      className={`tiffin-day-chip${skipped ? ' skipped' : ''}`}
                      disabled={busy !== null}
                      onClick={() =>
                        run(d, () => setTiffinDaySkipped(plan.id, d, !skipped), skipped ? `${dayLabel(d)} is back on` : `${dayLabel(d)} skipped`)
                      }
                    >
                      {busy === d ? <Spinner size={14} /> : dayLabel(d)}
                      {skipped && <span>Skipped</span>}
                    </button>
                  );
                })}
              </div>
              <div className="muted small">
                A day can be changed until {timeLabel(`${String(cutoffHour).padStart(2, '0')}:00`)} the evening before. Skipped days are not
                charged.
              </div>
            </div>
          )}

          <button
            className="btn btn-sm btn-outline"
            disabled={busy !== null}
            onClick={() =>
              run('pause', () => setTiffinPaused(plan.id, plan.status === 'active'), plan.status === 'active' ? 'Plan paused' : 'Plan resumed')
            }
          >
            {busy === 'pause' ? (
              <Spinner size={16} />
            ) : plan.status === 'active' ? (
              <>
                <Pause size={14} /> Pause plan
              </>
            ) : (
              <>
                <Play size={14} /> Resume plan
              </>
            )}
          </button>
        </>
      )}
    </section>
  );
}

function NewPlanForm({
  config,
  addresses,
  canClose,
  onClose,
  onCreated,
}: {
  config: TiffinConfig;
  addresses: CustomerAddress[];
  canClose: boolean;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}) {
  const navigate = useNavigate();
  const usable = addresses.filter((a) => a.id);
  const tomorrow = addDays(indiaToday(), 1);
  const [kind, setKind] = useState<TiffinKind>('school');
  const [name, setName] = useState('');
  const [detail, setDetail] = useState('');
  const [note, setNote] = useState('');
  const [pickupId, setPickupId] = useState<string>(() => usable.find((a) => a.is_default)?.id ?? usable[0]?.id ?? '');
  const [dropId, setDropId] = useState<string>('');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6]);
  const [pickupTime, setPickupTime] = useState('07:30');
  const [returnTrip, setReturnTrip] = useState(false);
  const [returnTime, setReturnTime] = useState('16:00');
  const [startDate, setStartDate] = useState(tomorrow);
  const [quote, setQuote] = useState<TiffinQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const meta = KINDS.find((k) => k.key === kind) ?? KINDS[0];

  // Live price from the server whenever the route, days or return choice change.
  useEffect(() => {
    if (!pickupId || !dropId || days.length === 0) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    getTiffinQuote(pickupId, dropId, days, returnTrip, startDate)
      .then((q) => !cancelled && setQuote(q))
      .catch((e) => !cancelled && setQuote({ ok: false, message: errorMessage(e) }))
      .finally(() => !cancelled && setQuoting(false));
    return () => {
      cancelled = true;
    };
  }, [pickupId, dropId, days, returnTrip, startDate]);

  const toggleDay = (n: number) => setDays((cur) => (cur.includes(n) ? cur.filter((d) => d !== n) : [...cur, n].sort()));

  const submit = async () => {
    setFormError(null);
    if (!name.trim()) return setFormError(`Enter the ${meta.who.toLowerCase()}.`);
    if (!pickupId || !dropId) return setFormError('Choose the pickup and drop addresses.');
    if (!quote?.ok) return setFormError(quote?.message ?? 'Choose the addresses and days to see the price.');
    setSaving(true);
    try {
      await createTiffinPlan({
        pickupAddressId: pickupId,
        dropAddressId: dropId,
        kind,
        recipientName: name.trim(),
        recipientDetail: detail.trim(),
        handoverNote: note.trim(),
        days,
        pickupTime,
        returnTrip,
        returnPickupTime: returnTime,
        startDate,
      });
      toast('Request sent. We will contact you for payment.');
      await onCreated();
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card tiffin-card tiffin-form">
      <div className="row between">
        <div className="tiffin-card-title">New tiffin plan</div>
        {canClose && (
          <button className="btn btn-sm btn-text" onClick={onClose}>
            Close
          </button>
        )}
      </div>

      <div className="tiffin-kinds" role="radiogroup" aria-label="Where does the tiffin go?">
        {KINDS.map((k) => (
          <button key={k.key} role="radio" aria-checked={kind === k.key} className={kind === k.key ? 'active' : ''} onClick={() => setKind(k.key)}>
            <k.Icon size={18} /> {k.label}
          </button>
        ))}
      </div>

      <label className="field">
        {meta.who}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Name" />
      </label>
      <label className="field">
        {meta.detail}
        <input value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={120} placeholder={kind === 'school' ? 'e.g. 5th B' : ''} />
      </label>

      {usable.length < 2 && (
        <div className="tiffin-note">
          You need two saved addresses: your home and the {kind === 'school' ? 'school' : 'drop place'}.
          <div className="mt-8">
            <button className="btn btn-sm btn-outline" onClick={() => navigate('/addresses')}>
              <Plus size={14} /> Add an address
            </button>
          </div>
        </div>
      )}

      <label className="field">
        Pickup from (home)
        <select className="input" value={pickupId} onChange={(e) => setPickupId(e.target.value)}>
          <option value="">Choose an address</option>
          {usable.map((a) => (
            <option key={a.id} value={a.id!}>
              {addressText(a)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Drop at ({kind === 'school' ? 'school' : kind === 'office' ? 'office' : 'place'})
        <select className="input" value={dropId} onChange={(e) => setDropId(e.target.value)}>
          <option value="">Choose an address</option>
          {usable
            .filter((a) => a.id !== pickupId)
            .map((a) => (
              <option key={a.id} value={a.id!}>
                {addressText(a)}
              </option>
            ))}
        </select>
      </label>
      {usable.length >= 2 && (
        <button className="btn btn-sm btn-text tiffin-add-address" onClick={() => navigate('/addresses')}>
          <Plus size={14} /> Add another address
        </button>
      )}

      <div className="field">
        Days
        <div className="tiffin-weekdays">
          {WEEKDAYS.map((d) => (
            <button key={d.n} aria-pressed={days.includes(d.n)} className={days.includes(d.n) ? 'active' : ''} onClick={() => toggleDay(d.n)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tiffin-two">
        <label className="field">
          Pickup time at home
          <input type="time" value={pickupTime} min={config.earliest_pickup} max={config.latest_pickup} onChange={(e) => setPickupTime(e.target.value)} />
        </label>
        <label className="field">
          Start date
          <input type="date" value={startDate} min={tomorrow} max={addDays(tomorrow, 13)} onChange={(e) => setStartDate(e.target.value || tomorrow)} />
        </label>
      </div>
      <div className="muted small">
        Pickup is possible between {timeLabel(config.earliest_pickup)} and {timeLabel(config.latest_pickup)}.
      </div>

      <label className="tiffin-check">
        <input type="checkbox" checked={returnTrip} onChange={(e) => setReturnTrip(e.target.checked)} />
        <span>
          <strong>Bring the empty box back home</strong>
          <span className="muted small"> (extra charge)</span>
        </span>
      </label>
      {returnTrip && (
        <label className="field">
          Collect the empty box at
          <input type="time" value={returnTime} max={config.latest_return_pickup} onChange={(e) => setReturnTime(e.target.value)} />
        </label>
      )}

      <label className="field">
        Handover instructions (optional)
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={240}
          rows={2}
          placeholder={kind === 'school' ? 'e.g. Give it to the security guard at the main gate' : 'e.g. Leave at reception'}
        />
      </label>

      <div className="tiffin-quote">
        {quoting ? (
          <Spinner size={18} />
        ) : !quote ? (
          <span className="muted small">Choose both addresses and the days to see the price.</span>
        ) : !quote.ok ? (
          <span className="text-danger small">{quote.message}</span>
        ) : (
          <>
            <div className="row between">
              <span>
                Tiffin drop · {quote.trips} days · {quote.distance_km} km
              </span>
              <strong>{rupees(quote.price_one_way)}</strong>
            </div>
            {returnTrip && (
              <div className="row between">
                <span>Empty box return</span>
                <strong>{rupees(quote.price_return)}</strong>
              </div>
            )}
            <div className="row between tiffin-quote-total">
              <span>Total for this plan</span>
              <strong>{rupees(quote.total)}</strong>
            </div>
          </>
        )}
      </div>

      {formError && <div className="alert alert-danger">{formError}</div>}

      <button className="btn btn-primary w-full" disabled={saving || quoting || !quote?.ok} onClick={() => void submit()}>
        {saving ? <Spinner size={18} light /> : 'Request this plan'}
      </button>
      <div className="muted small">
        No payment now. Our team will contact you to collect the payment, and the plan starts after that.
      </div>
    </section>
  );
}
