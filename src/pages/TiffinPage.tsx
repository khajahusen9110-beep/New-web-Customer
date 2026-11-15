import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, CalendarDays, Camera, CheckCircle2, Clock, GraduationCap, Home, MapPin, Package, Pause, Phone, Play, Plus, Repeat } from 'lucide-react';
import { ErrorCard, ListSkeleton, PageHeader, Spinner, toast } from '../components/ui';
import { getAddresses } from '../lib/repository';
import {
  addDays,
  cancelTiffinRequest,
  createTiffinPlan,
  isAutopayLive,
  payTiffinPlan,
  stopTiffinAutopay,
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
  setTiffinDateLocale,
} from '../lib/tiffin';
import { initialTiffinLang, saveTiffinLang, tt, type TiffinLang } from '../lib/tiffinI18n';
import type { CustomerAddress } from '../lib/types';
import { errorMessage, rupees } from '../lib/utils';
import { useSession } from '../store/session';

// Text of this page: English or Kannada, chosen by the customer (see TiffinGuide for the language chips).
const TxContext = createContext<{ lang: TiffinLang; tx: (key: string, ...args: (string | number | null | undefined)[]) => string }>({
  lang: 'en',
  tx: (key, ...args) => tt('en', key, ...args),
});
const useTx = () => useContext(TxContext);

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ n, key: `wd${n}` }));

const KINDS: { key: TiffinKind; Icon: typeof Home; label: string; who: string; detail: string; dropWord: string }[] = [
  { key: 'school', Icon: GraduationCap, label: 'kindSchool', who: 'whoSchool', detail: 'detSchool', dropWord: 'dropWordSchool' },
  { key: 'office', Icon: Briefcase, label: 'kindOffice', who: 'whoOffice', detail: 'detOffice', dropWord: 'dropWordOffice' },
  { key: 'other', Icon: Package, label: 'kindOther', who: 'whoOther', detail: 'detOther', dropWord: 'dropWordOther' },
];

const STATUS: Record<TiffinSubscription['status'], { label: string; cls: string }> = {
  pending_payment: { label: 'stPending', cls: 'tiffin-badge-warn' },
  active: { label: 'stActive', cls: 'tiffin-badge-ok' },
  paused: { label: 'stPaused', cls: 'tiffin-badge-muted' },
  completed: { label: 'stCompleted', cls: 'tiffin-badge-muted' },
  cancelled: { label: 'stCancelled', cls: 'tiffin-badge-muted' },
};

const TRIP_STATUS: Record<TiffinTrip['status'], string> = {
  scheduled: 'trScheduled',
  picked_up: 'trPicked',
  delivered: 'trDelivered',
  missed: 'trMissed',
  cancelled: 'trCancelled',
};

/** "23 Dec": short enough for the small stat tiles. */
const shortDate = (date: string, locale = 'en-IN') =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });

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
  const [lang, setLangState] = useState<TiffinLang>(initialTiffinLang);
  setTiffinDateLocale(lang);
  const ctx = useMemo(() => ({ lang, tx: (key: string, ...args: (string | number | null | undefined)[]) => tt(lang, key, ...args) }), [lang]);
  const setLang = (l: TiffinLang) => {
    saveTiffinLang(l);
    setLangState(l);
  };

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
    <TxContext.Provider value={ctx}>
    <div className="page tiffin-page">
      <PageHeader title={ctx.tx('title')} subtitle={ctx.tx('subtitle')} onBack={() => navigate('/')} />
      <div className="content-pad">
        {loading ? (
          <ListSkeleton count={3} height={120} />
        ) : error ? (
          <ErrorCard message={error} onRetry={() => void load()} />
        ) : (
          <>
            <section className="tiffin-hero">
              <div className="tiffin-lang" role="group" aria-label="Language">
                <button className={lang === 'en' ? 'active' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>
                  English
                </button>
                <button className={lang === 'kn' ? 'active' : ''} aria-pressed={lang === 'kn'} onClick={() => setLang('kn')}>
                  ಕನ್ನಡ
                </button>
              </div>
              <div className="tiffin-hero-title">{ctx.tx('heroTitle')}</div>
              <div className="tiffin-hero-sub">{ctx.tx('heroSub')}</div>
              <div className="tiffin-hero-steps">
                <span>
                  <Home size={14} /> {ctx.tx('stepPickup')}
                </span>
                <span>
                  <Camera size={14} /> {ctx.tx('stepPhoto')}
                </span>
                <span>
                  <CalendarDays size={14} /> {ctx.tx('stepSkip')}
                </span>
              </div>
            </section>

            {enabled && config && <TiffinGuide config={config} />}

            {!enabled && plans.length === 0 && (
              <p className="muted center-pad">{ctx.tx('notAvailable', city?.name ?? '—')}</p>
            )}

            {plans.map((p) => (
              <PlanCard key={p.id} plan={p} cutoffHour={config?.skip_cutoff_hour ?? 21} onChanged={load} />
            ))}

            {enabled && config && (
              <>
                {!showForm ? (
                  <button className="btn btn-outline w-full tiffin-new-btn" onClick={() => setShowForm(true)}>
                    <Plus size={18} /> {ctx.tx('newPlan')}
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
    </TxContext.Provider>
  );
}

function PriceTable({ config }: { config: TiffinConfig }) {
  const { tx } = useTx();
  return (
    <section className="card tiffin-card">
      <div className="tiffin-card-title">{tx('monthlyPrice')}</div>
      <div className="muted small">{tx('priceNote', config.full_month_trips)}</div>
      {config.trial_enabled && (
        <div className="tiffin-note">
          <strong>{tx('heroTrial', config.trial_days ?? 7, rupees(config.trial_price ?? 0))}</strong>
        </div>
      )}
      <div className="tiffin-price-rows">
        {config.slabs.map((s, i) => (
          <div key={i} className="tiffin-price-row">
            <span>{tx('upToKm', s.up_to_km)}</span>
            <span>
              <strong>{rupees(s.price)}</strong>
              <span className="muted small"> · {tx('boxReturnPlus', rupees(s.return_price))}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function AutopayInfo({
  plan,
  busy,
  run,
}: {
  plan: TiffinSubscription;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>, done?: string) => Promise<void>;
}) {
  const { tx } = useTx();
  const [confirming, setConfirming] = useState(false);
  const live = isAutopayLive(plan.autopay_status);
  if (plan.autopay_status === 'none' && !plan.is_trial) return null;
  return (
    <div className="tiffin-note">
      {plan.is_trial && plan.billing_cycles_paid === 0 && plan.trial_end_date && (
        <div>
          <strong>{tx('trialUntil', dayLabel(plan.trial_end_date))}</strong>
        </div>
      )}
      {live && plan.next_charge_date && (
        <div>
          <strong>{tx('nextPay', rupees(plan.total_amount), dayLabel(plan.next_charge_date))}</strong>
        </div>
      )}
      {plan.autopay_status === 'pending' && <div className="text-danger">{tx('payFailedRetry')}</div>}
      {plan.autopay_status === 'halted' && <div className="text-danger">{tx('halted', dayLabel(plan.end_date))}</div>}
      {plan.autopay_status === 'cancelled' && <div>{tx('stopped', dayLabel(plan.end_date))}</div>}
      {live &&
        (confirming ? (
          <div className="mt-8 row gap-8">
            <button
              className="btn btn-sm btn-danger"
              disabled={busy !== null}
              onClick={() => run('stop', () => stopTiffinAutopay(plan.id), tx('toastStopped'))}
            >
              {busy === 'stop' ? <Spinner size={16} light /> : tx('stopYes')}
            </button>
            <button className="btn btn-sm btn-text" onClick={() => setConfirming(false)}>
              {tx('stopKeep')}
            </button>
          </div>
        ) : (
          <div className="mt-8">
            <button className="btn btn-sm btn-outline" onClick={() => setConfirming(true)}>
              {tx('stopBtn')}
            </button>
          </div>
        ))}
    </div>
  );
}

function PlanCard({ plan, cutoffHour, onChanged }: { plan: TiffinSubscription; cutoffHour: number; onChanged: () => Promise<void> | void }) {
  const { tx, lang } = useTx();
  const [busy, setBusy] = useState<string | null>(null);
  const { userPhone, userEmail } = useSession();
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
    else toast(tx('photoFail'));
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
        <span className={`tiffin-badge ${STATUS[plan.status].cls}`}>{tx(STATUS[plan.status].label)}</span>
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
            {tx('pickupAt', timeLabel(plan.pickup_time), WEEKDAYS.filter((d) => plan.days.includes(d.n)).map((d) => tx(d.key)).join(', '))}
          </span>
        </div>
        {plan.return_trip && (
          <div>
            <Repeat size={14} /> <span>{tx('returnLine', timeLabel(plan.return_pickup_time))}</span>
          </div>
        )}
      </div>

      {plan.status === 'pending_payment' && (
        <div className="tiffin-note tiffin-note-warn">
          {plan.is_trial
            ? tx('pendingTrial', rupees(plan.trial_fee), plan.trial_days, dayLabel(plan.start_date), rupees(plan.total_amount))
            : tx('pendingNoTrial', rupees(plan.total_amount), dayLabel(plan.start_date))}
          <div className="mt-8 row gap-8">
            <button
              className="btn btn-sm btn-primary"
              disabled={busy !== null}
              onClick={() =>
                run('pay', async () => {
                  const r = await payTiffinPlan(plan.id, userPhone, userEmail);
                  if (r === 'paid') toast(tx(plan.is_trial ? 'toastTrialStarted' : 'toastPlanStarted'));
                })
              }
            >
              {busy === 'pay' ? <Spinner size={16} light /> : plan.is_trial ? tx('payTrialBtn', rupees(plan.trial_fee)) : tx('btnPay', rupees(plan.total_amount))}
            </button>
            <button
              className="btn btn-sm btn-outline"
              disabled={busy !== null}
              onClick={() => run('cancel', () => cancelTiffinRequest(plan.id), tx('toastCancelled'))}
            >
              {busy === 'cancel' ? <Spinner size={16} /> : tx('cancelRequest')}
            </button>
          </div>
        </div>
      )}

      {running && (
        <>
          <AutopayInfo plan={plan} busy={busy} run={run} />
          <div className="tiffin-stats">
            <div>
              <strong>{plan.trips_remaining}</strong>
              <span>{tx('daysLeft')}</span>
            </div>
            <div>
              <strong>{plan.trips_total}</strong>
              <span>{tx('daysMonth')}</span>
            </div>
            <div>
              <strong>{shortDate(plan.end_date, lang === 'kn' ? 'kn-IN' : 'en-IN')}</strong>
              <span>{tx('useBefore')}</span>
            </div>
          </div>

          {plan.partner ? (
            <div className="tiffin-partner">
              <span>
                {tx('partnerIs', '')}<strong>{plan.partner.name}</strong>
              </span>
              {plan.partner.phone && (
                <a className="btn btn-sm btn-outline" href={`tel:${plan.partner.phone}`}>
                  <Phone size={14} /> {tx('call')}
                </a>
              )}
            </div>
          ) : (
            <div className="muted small">{tx('partnerSoon')}</div>
          )}

          {todays.length > 0 && (
            <div className="tiffin-today">
              <div className="label-caps">{tx('todayHdr')}</div>
              {todays.map((t) => (
                <div key={t.id} className="tiffin-today-row">
                  <span>
                    {t.status === 'delivered' && <CheckCircle2 size={15} className="text-success" />}{' '}
                    {t.leg === 'drop' ? tx('tiffinWord') : tx('boxReturnWord')} · {tx(TRIP_STATUS[t.status])}
                    {t.status === 'scheduled' && ` ${tx('forTime', timeLabel(t.scheduled_time))}`}
                  </span>
                  {t.delivered_photo_url && (
                    <button className="btn btn-sm btn-text" onClick={() => void openPhoto(t.delivered_photo_url!)}>
                      <Camera size={14} /> {tx('photo')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {plan.status === 'active' && upcoming.length > 0 && (
            <div className="tiffin-days">
              <div className="label-caps">{tx('comingDays')}</div>
              <div className="tiffin-day-chips">
                {upcoming.map((d) => {
                  const skipped = plan.skips.includes(d);
                  return (
                    <button
                      key={d}
                      className={`tiffin-day-chip${skipped ? ' skipped' : ''}`}
                      disabled={busy !== null}
                      onClick={() =>
                        run(d, () => setTiffinDaySkipped(plan.id, d, !skipped), skipped ? tx('dayBack', dayLabel(d)) : tx('daySkipped', dayLabel(d)))
                      }
                    >
                      {busy === d ? <Spinner size={14} /> : dayLabel(d)}
                      {skipped && <span>{tx('skipped')}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="muted small">{tx('skipRule', timeLabel(`${String(cutoffHour).padStart(2, '0')}:00`))}</div>
            </div>
          )}

          <button
            className="btn btn-sm btn-outline"
            disabled={busy !== null}
            onClick={() =>
              run('pause', () => setTiffinPaused(plan.id, plan.status === 'active'), plan.status === 'active' ? tx('paused') : tx('resumed'))
            }
          >
            {busy === 'pause' ? (
              <Spinner size={16} />
            ) : plan.status === 'active' ? (
              <>
                <Pause size={14} /> {tx('pause')}
              </>
            ) : (
              <>
                <Play size={14} /> {tx('resume')}
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
  const { tx } = useTx();
  const { userPhone, userEmail } = useSession();
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
  const [accepted, setAccepted] = useState(false);
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
    if (!name.trim()) return setFormError(tx('errName', tx(meta.who).toLowerCase()));
    if (!pickupId || !dropId) return setFormError(tx('errAddr'));
    if (!quote?.ok) return setFormError(quote?.message ?? tx('quoteHint'));
    if (!accepted) return setFormError(tx('errTerms'));
    setSaving(true);
    try {
      const id = await createTiffinPlan({
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
      try {
        const r = await payTiffinPlan(id, userPhone, userEmail);
        toast(r === 'paid' ? tx(quote.trial_available ? 'toastTrialStarted' : 'toastPlanStarted') : tx('toastPlanSaved'));
      } catch (e) {
        toast(errorMessage(e));
      }
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
        <div className="tiffin-card-title">{tx('planFormTitle')}</div>
        {canClose && (
          <button className="btn btn-sm btn-text" onClick={onClose}>
            {tx('close')}
          </button>
        )}
      </div>

      <div className="tiffin-kinds" role="radiogroup" aria-label="Where does the tiffin go?">
        {KINDS.map((k) => (
          <button key={k.key} role="radio" aria-checked={kind === k.key} className={kind === k.key ? 'active' : ''} onClick={() => setKind(k.key)}>
            <k.Icon size={18} /> {tx(k.label)}
          </button>
        ))}
      </div>

      <label className="field">
        {tx(meta.who)}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={tx('phName')} />
      </label>
      <label className="field">
        {tx(meta.detail)}
        <input value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={120} placeholder={kind === 'school' ? tx('phClass') : ''} />
      </label>

      {usable.length < 2 && (
        <div className="tiffin-note">
          {tx('needTwoAddr', tx(meta.dropWord))}
          <div className="mt-8">
            <button className="btn btn-sm btn-outline" onClick={() => navigate('/addresses')}>
              <Plus size={14} /> {tx('addAddress')}
            </button>
          </div>
        </div>
      )}

      <label className="field">
        {tx('pickupFrom')}
        <select className="input" value={pickupId} onChange={(e) => setPickupId(e.target.value)}>
          <option value="">{tx('chooseAddr')}</option>
          {usable.map((a) => (
            <option key={a.id} value={a.id!}>
              {addressText(a)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {tx('dropAt', tx(meta.dropWord))}
        <select className="input" value={dropId} onChange={(e) => setDropId(e.target.value)}>
          <option value="">{tx('chooseAddr')}</option>
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
          <Plus size={14} /> {tx('addAnother')}
        </button>
      )}

      <div className="field">
        {tx('days')}
        <div className="tiffin-weekdays">
          {WEEKDAYS.map((d) => (
            <button key={d.n} aria-pressed={days.includes(d.n)} className={days.includes(d.n) ? 'active' : ''} onClick={() => toggleDay(d.n)}>
              {tx(d.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="tiffin-two">
        <label className="field">
          {tx('pickupTimeHome')}
          <input type="time" value={pickupTime} min={config.earliest_pickup} max={config.latest_pickup} onChange={(e) => setPickupTime(e.target.value)} />
        </label>
        <label className="field">
          {tx('startDate')}
          <input type="date" value={startDate} min={tomorrow} max={addDays(tomorrow, 13)} onChange={(e) => setStartDate(e.target.value || tomorrow)} />
        </label>
      </div>
      <div className="muted small">{tx('pickupWindow', timeLabel(config.earliest_pickup), timeLabel(config.latest_pickup))}</div>

      <label className="tiffin-check">
        <input type="checkbox" checked={returnTrip} onChange={(e) => setReturnTrip(e.target.checked)} />
        <span>
          <strong>{tx('returnTrip')}</strong>
          <span className="muted small"> {tx('extraCharge')}</span>
        </span>
      </label>
      {returnTrip && (
        <label className="field">
          {tx('returnAt')}
          <input type="time" value={returnTime} max={config.latest_return_pickup} onChange={(e) => setReturnTime(e.target.value)} />
        </label>
      )}

      <label className="field">
        {tx('handoverNote')}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={240}
          rows={2}
          placeholder={kind === 'school' ? tx('phNoteSchool') : tx('phNoteOther')}
        />
      </label>

      <div className="tiffin-quote">
        {quoting ? (
          <Spinner size={18} />
        ) : !quote ? (
          <span className="muted small">{tx('quoteHint')}</span>
        ) : !quote.ok ? (
          <span className="text-danger small">{quote.message}</span>
        ) : (
          <>
            <div className="row between">
              <span>{tx('quoteDrop', quote.trips, quote.distance_km)}</span>
              <strong>{rupees(quote.price_one_way)}</strong>
            </div>
            {returnTrip && (
              <div className="row between">
                <span>{tx('quoteReturn')}</span>
                <strong>{rupees(quote.price_return)}</strong>
              </div>
            )}
            <div className="row between tiffin-quote-total">
              <span>{quote.trial_available ? tx('everyMonthAfter') : tx('everyMonth')}</span>
              <strong>{rupees(quote.total)}</strong>
            </div>
            {quote.trial_available && (
              <div className="tiffin-trial-line">
                <span>
                  <strong>{tx('trialLine', quote.trial_days, quote.trial_trips)}</strong>
                </span>
                <strong>{tx('payToday', rupees(quote.trial_price))}</strong>
              </div>
            )}
          </>
        )}
      </div>

      <TiffinTerms config={config} />
      <label className="tiffin-check tiffin-accept">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        <span>{tx('accept')}</span>
      </label>

      {formError && <div className="alert alert-danger">{formError}</div>}

      <button className="btn btn-primary w-full" disabled={saving || quoting || !quote?.ok || !accepted} onClick={() => void submit()}>
        {saving ? (
          <Spinner size={18} light />
        ) : quote?.ok && quote.trial_available ? (
          tx('btnTrial', quote.trial_days, rupees(quote.trial_price))
        ) : quote?.ok ? (
          tx('btnPay', rupees(quote.total))
        ) : (
          tx('btnStart')
        )}
      </button>
      <div className="muted small">
        {quote?.ok && quote.trial_available
          ? tx('trialNote', rupees(quote.trial_price), dayLabel(quote.first_charge_date ?? startDate), rupees(quote.total))
          : tx('payNote')}
      </div>
    </section>
  );
}

/** "How it works": six short steps, in the customer's language. */
function TiffinGuide({ config }: { config: TiffinConfig }) {
  const { tx } = useTx();
  const steps = ['g1', ...(config.trial_enabled ? ['g2'] : []), 'g3', 'g4', 'g5', 'g6'];
  return (
    <section className="card tiffin-card tiffin-guide">
      <div className="tiffin-card-title">{tx('guideTitle')}</div>
      <ol>
        {steps.map((k) => {
          const text = k === 'g2' ? tx('g2', config.trial_days ?? 7, rupees(config.trial_price ?? 0)) : tx(k);
          const cut = text.indexOf('.');
          // The first sentence of each step is its heading.
          return (
            <li key={k}>
              <strong>{text.slice(0, cut + 1)}</strong>
              {text.slice(cut + 1)}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Terms & Conditions, opened on demand above the "I agree" checkbox. */
function TiffinTerms({ config }: { config: TiffinConfig }) {
  const { tx } = useTx();
  const maxKm = config.slabs.length ? config.slabs[config.slabs.length - 1].up_to_km : 10;
  const cutoff = timeLabel(`${String(config.skip_cutoff_hour).padStart(2, '0')}:00`);
  const keys = Array.from({ length: 13 }, (_, i) => `t${i + 1}`).filter((k) => k !== 't7' || config.trial_enabled);
  return (
    <details className="tiffin-terms">
      <summary>{tx('termsOpen')}</summary>
      <div className="tiffin-card-title">{tx('termsTitle')}</div>
      <ol>
        {keys.map((k) => {
          const text = k === 't5' ? tx(k, cutoff) : k === 't11' ? tx(k, maxKm) : tx(k);
          const cut = text.indexOf('.');
          return (
            <li key={k}>
              <strong>{text.slice(0, cut + 1)}</strong>
              {text.slice(cut + 1)}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
