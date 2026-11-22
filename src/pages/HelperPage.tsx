import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Camera, CheckCircle2, Clock, MapPin, Phone, Star, X } from 'lucide-react';
import { useSession } from '../store/session';
import { EmptyState, ErrorCard, ListSkeleton, PageHeader, Spinner, toast } from '../components/ui';
import { AddressPickerModal } from '../components/AddressPickerModal';
import { getAddresses } from '../lib/repository';
import type { CustomerAddress } from '../lib/types';
import { errorMessage, rupees } from '../lib/utils';
import {
  STATUS_LABEL, cancelHelperBooking, createHelperBooking, getHelperBooking, getHelperConfig, helperPhotoUrl, isActive,
  myHelperBookings, rateHelperBooking, uploadHelperPhoto, type HelperBooking, type HelperCategory, type HelperConfig,
} from '../lib/helper';

/** Quick Helper: book a nearby helper for 30 / 60 / 90 minutes. */
export default function HelperPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const city = useSession((s) => s.selectedCity);
  const userId = useSession((s) => s.userId);
  const cityId = city?.id ?? null;
  const [cfg, setCfg] = useState<HelperConfig | null>(null);
  const openId = params.get('b');
  const tab = params.get('tab') === 'mine' ? 'mine' : 'book';

  useEffect(() => { void getHelperConfig(cityId).then(setCfg); }, [cityId]);
  useEffect(() => { if (cfg && !cfg.enabled) navigate('/', { replace: true }); }, [cfg, navigate]);

  if (!userId) {
    return (
      <div className="page">
        <PageHeader title="Quick Helper" subtitle={city?.name} />
        <div className="content-pad narrow">
          <EmptyState icon={<Clock size={36} />} title="Please log in" text="Log in to book a helper." action={<button className="btn btn-primary" onClick={() => navigate('/auth')}>Log in</button>} />
        </div>
      </div>
    );
  }
  if (!cfg) return <div className="page"><PageHeader title="Quick Helper" subtitle={city?.name} /><div className="content-pad narrow"><ListSkeleton /></div></div>;

  return (
    <div className="page">
      <PageHeader title="Quick Helper" subtitle={`Pay per 30 minutes${city?.name ? ' · ' + city.name : ''}`} />
      <div className="content-pad narrow stack">
        {openId ? (
          <BookingDetail id={openId} onBack={() => setParams({ tab: 'mine' })} />
        ) : (
          <>
            <div className="mode-toggle">
              <button className={tab === 'book' ? 'active' : ''} onClick={() => setParams({})}>Book a helper</button>
              <button className={tab === 'mine' ? 'active' : ''} onClick={() => setParams({ tab: 'mine' })}>My bookings</button>
            </div>
            {tab === 'book'
              ? <BookForm cfg={cfg} cityId={cityId!} userId={userId} onBooked={(b) => setParams({ b: b.id })} />
              : <MyBookings onOpen={(id) => setParams({ b: id })} />}
          </>
        )}
      </div>
    </div>
  );
}

function BookForm({ cfg, cityId, userId, onBooked }: { cfg: HelperConfig; cityId: string; userId: string; onBooked: (b: HelperBooking) => void }) {
  const cats = cfg.categories ?? [];
  const [cat, setCat] = useState<HelperCategory | null>(null);
  const [minutes, setMinutes] = useState(30);
  const [desc, setDesc] = useState('');
  const [photos, setPhotos] = useState<{ path: string; preview: string }[]>([]);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [addressId, setAddressId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState('');
  const [pay, setPay] = useState<'upi' | 'cash'>(cfg.payment_mode === 'cash' ? 'cash' : 'upi');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadAddresses = useCallback(async (select?: string | null) => {
    try {
      const list = await getAddresses(userId);
      setAddresses(list);
      setAddressId((cur) => select ?? cur ?? (list.find((a) => a.is_default) ?? list[0])?.id ?? null);
    } catch (e) { toast(errorMessage(e, 'Failed to load addresses')); }
  }, [userId]);
  useEffect(() => { void loadAddresses(); }, [loadAddresses]);

  const choose = (c: HelperCategory) => {
    setCat(c); setMinutes(c.durations[0] ?? 30); setPhotos([]); setAck(false); window.scrollTo({ top: 0 });
  };

  if (cats.length === 0) return <EmptyState icon={<Clock size={36} />} title="No services yet" text="Please check again soon." />;

  // Step 1: browse the services
  if (!cat) {
    return (
      <>
        <strong>Choose a service</strong>
        {cats.map((c) => (
          <button key={c.id} className="card pad row gap-8" style={{ textAlign: 'left', alignItems: 'center' }} onClick={() => choose(c)}>
            {c.image_url ? <img src={c.image_url} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 12, flexShrink: 0 }} /> : null}
            <span className="stack" style={{ gap: 2 }}>
              <strong>{c.name}</strong>
              {c.description && <span className="muted small">{c.description}</span>}
              <span className="small">From {rupees(Math.min(...Object.values(c.prices)), 0)} · {c.durations.join(' / ')} min</span>
            </span>
          </button>
        ))}
        {cfg.banned_note && <p className="muted small">{cfg.banned_note}</p>}
      </>
    );
  }

  const price = cat.prices[String(minutes)] ?? cat.rate_per_30 * minutes / 30;
  const maxPhotos = cat.photos_allowed ? (cfg.max_photos ?? 3) : 0;
  const mode = cfg.payment_mode ?? 'both';

  const addPhoto = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const path = await uploadHelperPhoto(userId, file);
      setPhotos((p) => [...p, { path, preview: URL.createObjectURL(file) }]);
    } catch (e) { toast(errorMessage(e, 'Photo upload failed')); } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const minWhen = () => {
    const d = new Date(Date.now() + ((cfg.min_lead_minutes ?? 30) + 5) * 60_000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };
  const maxWhen = () => {
    const d = new Date(Date.now() + (cfg.max_days_ahead ?? 7) * 86_400_000);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  };

  const submit = async () => {
    if (!addressId) { toast('Choose your address'); return; }
    if (desc.trim().length < 5) { toast('Please describe the task'); return; }
    if (later && !when) { toast('Choose the time'); return; }
    if (cat.photo_required && photos.length === 0) { toast('Please add a photo'); return; }
    if (cfg.require_rules_ack !== false && !ack) { toast('Please accept what the helper does and does not do'); return; }
    setBusy(true);
    try {
      const b = await createHelperBooking({
        cityId, addressId, categoryId: cat.id, description: desc.trim(), photoPaths: photos.map((p) => p.path), minutes,
        requestedFor: later ? new Date(when).toISOString() : null, paymentMethod: mode === 'both' ? pay : mode, rulesAccepted: ack,
      });
      toast('Request sent. We are finding a helper.');
      onBooked(b);
    } catch (e) { toast(errorMessage(e, 'Could not book')); } finally { setBusy(false); }
  };

  const RuleList = ({ title, items, good }: { title: string; items: HelperCategory['dos']; good: boolean }) => items.length === 0 ? null : (
    <div className="stack">
      <strong style={{ color: good ? '#047857' : '#be123c' }}>{good ? '✓ ' : '✕ '}{title}</strong>
      {items.map((r, i) => (
        <div key={i} className="row gap-8" style={{ alignItems: 'center' }}>
          {r.image_url ? <img src={r.image_url} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 10, flexShrink: 0 }} /> : null}
          <span className="small">{r.text}</span>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <button className="btn btn-outline" onClick={() => setCat(null)}>← All services</button>
      <div className="card pad stack">
        <div className="row gap-8" style={{ alignItems: 'center' }}>
          {cat.image_url ? <img src={cat.image_url} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 12 }} /> : null}
          <span className="stack" style={{ gap: 2 }}><strong>{cat.name}</strong>{cat.description && <span className="muted small">{cat.description}</span>}</span>
        </div>
        <RuleList title="The helper does" items={cat.dos} good />
        <RuleList title="The helper does not" items={cat.donts} good={false} />
      </div>

      <div className="card pad stack">
        <strong>How long do you need a helper?</strong>
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          {cat.durations.map((d) => (
            <button key={d} className={`btn ${minutes === d ? 'btn-primary' : 'btn-outline'}`} onClick={() => setMinutes(d)}>
              {d} min · {rupees(cat.prices[String(d)] ?? cat.rate_per_30 * d / 30)}
            </button>
          ))}
        </div>
      </div>

      <div className="card pad stack">
        <strong>Describe the task</strong>
        <textarea className="input" rows={4} maxLength={600} value={desc} onChange={(e) => setDesc(e.target.value)}
          placeholder={cat.task_placeholder || 'Describe what you need, e.g. place, what to do, anything the helper should know'} />
        <span className="muted small">{desc.length}/600</span>
        {maxPhotos > 0 && (
          <div>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void addPhoto(e.target.files?.[0])} />
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              {photos.map((p, i) => (
                <div key={p.path} style={{ position: 'relative' }}>
                  <img src={p.preview} alt="Reference" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 10 }} />
                  <button className="icon-btn sm" aria-label="Remove photo" style={{ position: 'absolute', top: -6, right: -6 }}
                    onClick={() => setPhotos((x) => x.filter((_, j) => j !== i))}><X size={14} /></button>
                </div>
              ))}
              {photos.length < maxPhotos && (
                <button className="btn btn-outline" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? <Spinner size={16} /> : <Camera size={16} />} Add photo
                </button>
              )}
            </div>
            <p className="muted small">{cat.photo_required ? 'A photo is required.' : 'Optional.'} Only you, your helper and Sndmart can see these.</p>
          </div>
        )}
      </div>

      <div className="card pad stack">
        <strong>Where?</strong>
        {addresses.length === 0 ? <p className="muted small">No saved address yet.</p> : addresses.map((a) => (
          <label key={a.id} className="row gap-8" style={{ alignItems: 'flex-start' }}>
            <input type="radio" name="addr" checked={addressId === a.id} onChange={() => setAddressId(a.id ?? null)} />
            <span><strong>{a.label}</strong><br /><span className="muted small">{a.address_line}</span></span>
          </label>
        ))}
        <button className="btn btn-outline" onClick={() => setShowAdd(true)}><MapPin size={14} /> Add new address</button>
      </div>

      <div className="card pad stack">
        <strong>When?</strong>
        <div className="row gap-8">
          <button className={`btn ${!later ? 'btn-primary' : 'btn-outline'}`} onClick={() => setLater(false)}>As soon as possible</button>
          <button className={`btn ${later ? 'btn-primary' : 'btn-outline'}`} onClick={() => setLater(true)}>Choose time</button>
        </div>
        {later && <input className="input" type="datetime-local" min={minWhen()} max={maxWhen()} value={when} onChange={(e) => setWhen(e.target.value)} />}
      </div>

      <div className="card pad stack">
        <strong>How will you pay?</strong>
        {mode === 'both' ? (
          <div className="row gap-8">
            <button className={`btn ${pay === 'upi' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPay('upi')}>UPI</button>
            <button className={`btn ${pay === 'cash' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPay('cash')}>Cash</button>
          </div>
        ) : <span>{mode === 'upi' ? 'UPI' : 'Cash'} only</span>}
        <p className="muted small">Pay your helper directly after the work is done{(mode === 'upi' || (mode === 'both' && pay === 'upi')) ? ' (scan the helper’s UPI or pay to their number)' : ''}.</p>
      </div>

      {cfg.terms_text && <div className="card pad"><p className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{cfg.terms_text}</p></div>}
      {cfg.banned_note && <p className="muted small">{cfg.banned_note}</p>}

      <div className="card pad stack">
        {cfg.require_rules_ack !== false && (
          <label className="row gap-8" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span className="small">I have read what the helper does and does not do.</span>
          </label>
        )}
        <div className="row between"><strong>Total</strong><strong>{rupees(price, 0)}</strong></div>
        <button className="btn btn-primary btn-lg" disabled={busy || uploading} onClick={submit}>
          {busy ? <Spinner size={16} /> : `Book helper · ${rupees(price, 0)}`}
        </button>
        {cfg.support_phone && <p className="muted small">Need help? <a href={`tel:${cfg.support_phone}`}>{cfg.support_phone}</a></p>}
      </div>

      {showAdd && (
        <AddressPickerModal open onClose={() => setShowAdd(false)} onSaved={(a) => { setShowAdd(false); void loadAddresses(a.id ?? null); useSession.getState().setHasSavedAddress(true); }} />
      )}
    </>
  );
}

function MyBookings({ onOpen }: { onOpen: (id: string) => void }) {
  const [list, setList] = useState<HelperBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { setError(null); try { setList(await myHelperBookings()); } catch (e) { setError((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (error) return <ErrorCard message={error} onRetry={load} />;
  if (!list) return <ListSkeleton />;
  if (list.length === 0) return <EmptyState icon={<Clock size={36} />} title="No bookings yet" text="Your helper bookings will show here." />;
  return (
    <>
      {list.map((b) => (
        <button key={b.id} className="card pad stack" style={{ textAlign: 'left' }} onClick={() => onOpen(b.id)}>
          <div className="row between"><strong>{b.task_type}</strong><span className="muted small">{STATUS_LABEL[b.status]}</span></div>
          <span className="muted small">{b.duration_minutes} min · {rupees(b.price_total, 0)} · {new Date(b.created_at).toLocaleString()}</span>
        </button>
      ))}
    </>
  );
}

function BookingDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [b, setB] = useState<HelperBooking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState('');

  const load = useCallback(async () => {
    try { setB(await getHelperBooking(id)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // live status while the booking is open
  useEffect(() => {
    if (!b || !isActive(b.status)) return;
    const t = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(t);
  }, [b, load]);
  useEffect(() => {
    if (!b?.photo_paths?.length) return;
    let off = false;
    void Promise.all(b.photo_paths.map(helperPhotoUrl)).then((u) => !off && setPhotoUrls(u.filter(Boolean) as string[]));
    return () => { off = true; };
  }, [b?.photo_paths?.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  // time left once the work has started
  useEffect(() => {
    if (b?.status !== 'started' || !b.ends_at) { setLeft(''); return; }
    const tick = () => {
      const s = Math.max(0, Math.round((new Date(b.ends_at!).getTime() - Date.now()) / 1000));
      setLeft(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [b?.status, b?.ends_at]);

  if (error) return <><button className="btn btn-outline" onClick={onBack}>Back</button><ErrorCard message={error} onRetry={load} /></>;
  if (!b) return <ListSkeleton />;

  const cancel = async () => {
    if (!window.confirm('Cancel this booking?')) return;
    setBusy(true);
    try { await cancelHelperBooking(b.id); await load(); } catch (e) { toast(errorMessage(e, 'Could not cancel')); } finally { setBusy(false); }
  };
  const rate = async () => {
    if (!stars) { toast('Choose a star rating'); return; }
    setBusy(true);
    try { await rateHelperBooking(b.id, stars, review.trim()); toast('Thanks for your rating'); await load(); } catch (e) { toast(errorMessage(e, 'Could not rate')); } finally { setBusy(false); }
  };

  return (
    <>
      <button className="btn btn-outline" onClick={onBack}>All bookings</button>
      <div className="card pad stack">
        <div className="row between"><strong>{b.booking_number}</strong><strong>{STATUS_LABEL[b.status]}</strong></div>
        <span>{b.task_type} · {b.duration_minutes} min · {rupees(b.price_total, 0)} · pay by {b.payment_method === 'upi' ? 'UPI' : 'cash'}</span>
        <p>{b.task_description}</p>
        <span className="muted small"><MapPin size={12} /> {b.address_line}</span>
        {photoUrls.length > 0 && (
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            {photoUrls.map((u) => <img key={u} src={u} alt="Reference" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 10 }} />)}
          </div>
        )}
      </div>

      {b.status === 'requested' && <div className="card pad"><Spinner size={16} /> We are finding a helper near you. This can take a few minutes.</div>}

      {b.helper && (
        <div className="card pad stack">
          <strong>Your helper</strong>
          <div className="row between">
            <span>{b.helper.name} {b.helper.total_ratings ? <span className="muted small"><Star size={12} /> {Number(b.helper.avg_rating ?? 0).toFixed(1)} ({b.helper.total_ratings})</span> : null}</span>
            {b.helper.phone && isActive(b.status) && <a className="btn btn-outline" href={`tel:${b.helper.phone}`}><Phone size={14} /> Call</a>}
          </div>
        </div>
      )}

      {b.start_otp && (
        <div className="card pad stack"><strong>Start code</strong><span style={{ fontSize: 28, letterSpacing: 6 }}>{b.start_otp}</span>
          <span className="muted small">Tell this code to your helper when they arrive, to start the work.</span></div>
      )}
      {b.status === 'started' && (
        <div className="card pad stack">
          <strong>Work in progress {left && <>· {left} left</>}</strong>
          {b.end_otp && <><span style={{ fontSize: 28, letterSpacing: 6 }}>{b.end_otp}</span><span className="muted small">Tell this code to your helper when the work is finished.</span></>}
        </div>
      )}
      {b.status === 'completed' && (
        <div className="card pad stack">
          <div className="row gap-8"><CheckCircle2 size={18} /><strong>Work completed</strong></div>
          <span>Please pay {rupees(b.price_total, 0)} to your helper ({b.payment_method === 'upi' ? 'UPI' : 'cash'}).</span>
          {b.rating ? (
            <span className="muted small">You rated {b.rating}/5{b.review ? ` · ${b.review}` : ''}</span>
          ) : (
            <>
              <div className="row gap-8">{[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className="icon-btn" aria-label={`${n} star`} onClick={() => setStars(n)}><Star size={26} fill={n <= stars ? 'currentColor' : 'none'} /></button>
              ))}</div>
              <textarea className="input" rows={2} maxLength={300} value={review} onChange={(e) => setReview(e.target.value)} placeholder="Say something about your helper (optional)" />
              <button className="btn btn-primary" disabled={busy} onClick={rate}>Submit rating</button>
            </>
          )}
        </div>
      )}
      {(b.status === 'cancelled' || b.status === 'expired') && <div className="card pad muted">{b.cancel_reason || STATUS_LABEL[b.status]}</div>}
      {(b.status === 'requested' || b.status === 'accepted' || b.status === 'on_the_way') && (
        <button className="btn btn-outline" disabled={busy} onClick={cancel}>Cancel booking</button>
      )}
    </>
  );
}
