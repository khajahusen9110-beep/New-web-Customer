import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { BadgeCheck, MessageSquareText, ShoppingBag, UserRound, X } from 'lucide-react';
import { PageHeader, Spinner, toast } from '../components/ui';
import { Turnstile, TURNSTILE_SITE_KEY } from '../components/Turnstile';
import {
  createProfile,
  getAddresses,
  getProfile,
  registerDeviceSession,
  resolveUserCity,
  sendPhoneOtp,
  verifyPhoneOtp,
} from '../lib/repository';
import { errorMessage, isValidPhoneNumber, to10Digits, toE164 } from '../lib/utils';
import { useSession } from '../store/session';
import { useCart } from '../store/cart';

type Step = 'phone' | 'otp' | 'name';

function OtpInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="otp" onClick={() => ref.current?.focus()}>
      <input
        ref={ref}
        className="otp-real"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="6-digit OTP"
        maxLength={6}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className={`otp-cell${value.length === i || (i === 5 && value.length === 6) ? ' current' : ''}`}>
          {value[i] ?? ''}
        </div>
      ))}
    </div>
  );
}

export default function AuthPage() {
  const navigate = useNavigate();
  const session = useSession();
  const [step, setStep] = useState<Step>('phone');
  const [mobile, setMobile] = useState('');
  const [otp, setOtp] = useState('');
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const [verifiedUserId, setVerifiedUserId] = useState('');
  const [verifiedPhone, setVerifiedPhone] = useState('');

  useEffect(() => {
    if (session.sessionExpiredMessage) session.clearSessionExpiredMessage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Already signed in (e.g. user opened /auth directly): go home.
  if (session.isLoggedIn && step === 'phone' && !loading) return <Navigate to="/" replace />;

  const captchaReady = !TURNSTILE_SITE_KEY || !!captchaToken;

  async function sendOtp(isResend = false) {
    if (!isValidPhoneNumber(mobile)) {
      setError('Please enter a valid 10-digit mobile number.');
      return;
    }
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setError('Please complete the security check first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await sendPhoneOtp(mobile, captchaToken);
      setStep('otp');
      setOtp('');
      setCooldown(30);
      toast(`OTP ${isResend ? 'resent' : 'sent'} to ${toE164(mobile)}`);
    } catch (e) {
      setError(errorMessage(e, 'Failed to send OTP. Please check your number.'));
    } finally {
      setLoading(false);
      // Security-check tokens are single-use: get a fresh one for the next request.
      if (TURNSTILE_SITE_KEY) setCaptchaReset((k) => k + 1);
    }
  }

  async function finishReturningUser(uid: string) {
    const s = useSession.getState();
    const city = await resolveUserCity(uid);
    if (city) s.setSelectedCity(city);
    await useCart.getState().hydrateForUser(uid);
    const addresses = await getAddresses(uid).catch(() => []);
    if (addresses.length) {
      const def = addresses.find((a) => a.is_default) ?? addresses[0];
      s.setHasSavedAddress(true, def.label);
      navigate('/', { replace: true });
    } else {
      s.setHasSavedAddress(false);
      navigate('/onboarding', { replace: true });
    }
  }

  async function verifyOtp(code = otp) {
    if (code.length !== 6) {
      setError('Please enter the complete 6-digit OTP code.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await verifyPhoneOtp(mobile, code);
      const user = data.user!;
      const phone = user.phone ? toE164(user.phone) : toE164(mobile);
      setVerifiedUserId(user.id);
      setVerifiedPhone(phone);
      const s = useSession.getState();
      s.saveSession({ userId: user.id, email: user.email ?? null, phone });

      // Single device login: this browser becomes the active session.
      await registerDeviceSession(user.id);

      const profile = await getProfile(user.id, true);
      if (!profile || !profile.full_name?.trim()) {
        setStep('name');
      } else if (profile.city_id) {
        s.updateProfileInfo(profile);
        await finishReturningUser(user.id);
      } else {
        s.setHasSavedAddress(false);
        s.updateProfileInfo(profile);
        navigate('/onboarding', { replace: true });
      }
    } catch (e) {
      setError(errorMessage(e, 'OTP verification failed.'));
    } finally {
      setLoading(false);
    }
  }

  async function saveName() {
    const name = fullName.trim();
    if (!name) {
      setError('Please enter your full name.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const s = useSession.getState();
      const uid = verifiedUserId || s.userId || '';
      const phone = toE164(verifiedPhone || mobile);
      const saved = await createProfile({
        id: uid,
        role: 'customer',
        full_name: name,
        phone,
        current_device_session: s.deviceId,
      });
      await registerDeviceSession(uid);
      s.saveSession({ userId: uid, name, phone });
      await useCart.getState().hydrateForUser(uid);
      s.updateProfileInfo(saved);
      navigate('/onboarding', { replace: true });
    } catch (e) {
      setError(errorMessage(e, 'Could not save profile. Please try again.'));
    } finally {
      setLoading(false);
    }
  }

  const backToPhone = () => {
    setStep('phone');
    setError(null);
    setOtp('');
  };

  const title = step === 'phone' ? 'Welcome to Sndmart' : step === 'otp' ? 'Verify Mobile' : 'Your Profile';

  return (
    <div className="auth-page">
      <PageHeader title={title} back={step !== 'phone'} onBack={backToPhone} />
      <div className="auth-body">
        {error && (
          <div className="alert alert-danger row between">
            <span>{error}</span>
            <button className="icon-btn sm" aria-label="Dismiss" onClick={() => setError(null)}>
              <X size={16} />
            </button>
          </div>
        )}

        {step === 'phone' && (
          <form
            className="auth-card"
            onSubmit={(e) => {
              e.preventDefault();
              if (mobile.length === 10 && !loading && captchaReady) void sendOtp();
            }}
          >
            <div className="hero-icon">
              <ShoppingBag size={40} />
            </div>
            <h2>Login or Sign Up</h2>
            <p className="muted center">Enter your 10-digit mobile number to proceed. We'll send a 6-digit OTP.</p>
            <label className="field">
              <span>Mobile Number</span>
              <div className="phone-input">
                <span className="prefix">🇮🇳 +91</span>
                <input
                  inputMode="tel"
                  autoComplete="tel-national"
                  placeholder="Enter 10 digits"
                  value={mobile}
                  onChange={(e) => {
                    setMobile(to10Digits(e.target.value));
                    setError(null);
                  }}
                  autoFocus
                />
              </div>
              <span className={`hint row between${mobile.length === 10 ? ' text-primary' : ''}`}>
                <span>{mobile.length === 10 ? 'Valid 10-digit number' : '10 digits required'}</span>
                <span>{mobile.length}/10</span>
              </span>
            </label>
            {TURNSTILE_SITE_KEY && <Turnstile onToken={setCaptchaToken} resetKey={captchaReset} />}
            <button
              className="btn btn-primary btn-lg w-full"
              disabled={mobile.length !== 10 || loading || !captchaReady}
              type="submit"
            >
              {loading ? <Spinner size={22} light /> : 'Continue'}
            </button>
            <p className="muted small center">By continuing, you agree to Sndmart's Terms of Service and Privacy Policy.</p>
          </form>
        )}

        {step === 'phone' && (
          <section className="auth-about" aria-labelledby="about-sndmart">
            <h2 id="about-sndmart">Grocery &amp; food delivery in Sindhanur</h2>
            <p>
              Sndmart brings fresh groceries, fruits, vegetables and food from local hotels to your doorstep in
              Sindhanur, Karnataka.
            </p>
            <ul>
              <li>Daily groceries and fresh fruits at local prices</li>
              <li>Order food from nearby hotels and restaurants</li>
              <li>Pay with Cash on Delivery or UPI</li>
            </ul>
            <a href="https://play.google.com/store/apps/details?id=in.sndmart.app" target="_blank" rel="noopener noreferrer">
              Get the Sndmart app on Google Play
            </a>
          </section>
        )}

        {step === 'otp' && (
          <div className="auth-card">
            <div className="hero-icon">
              <MessageSquareText size={40} />
            </div>
            <h2>Verify with OTP</h2>
            <p className="muted">
              Sent to {toE164(mobile)}{' '}
              <button className="link-btn" onClick={backToPhone}>
                Edit
              </button>
            </p>
            <OtpInput
              value={otp}
              disabled={loading}
              onChange={(v) => {
                setOtp(v);
                setError(null);
                if (v.length === 6 && !loading) void verifyOtp(v);
              }}
            />
            {cooldown > 0 ? (
              <p className="muted small">Resend OTP in {cooldown}s</p>
            ) : (
              <>
                {TURNSTILE_SITE_KEY && <Turnstile onToken={setCaptchaToken} resetKey={captchaReset} />}
                <p className="muted small">
                  Didn't receive the OTP?{' '}
                  <button className="link-btn" disabled={loading || !captchaReady} onClick={() => void sendOtp(true)}>
                    Resend OTP
                  </button>
                </p>
              </>
            )}
            <button className="btn btn-primary btn-lg w-full" disabled={otp.length !== 6 || loading} onClick={() => void verifyOtp()}>
              {loading ? <Spinner size={22} light /> : 'Verify & Continue'}
            </button>
          </div>
        )}

        {step === 'name' && (
          <form
            className="auth-card"
            onSubmit={(e) => {
              e.preventDefault();
              if (fullName.trim() && !loading) void saveName();
            }}
          >
            <div className="hero-icon">
              <UserRound size={40} />
            </div>
            <h2>What's your name?</h2>
            <p className="muted center">Please enter your full name so delivery partners know who to look for.</p>
            <label className="field">
              <span>Full Name</span>
              <div className="input-icon">
                <BadgeCheck size={18} className="text-primary" />
                <input
                  placeholder="e.g. Rahul Sharma"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  autoFocus
                />
              </div>
            </label>
            <button className="btn btn-primary btn-lg w-full" disabled={!fullName.trim() || loading} type="submit">
              {loading ? <Spinner size={22} light /> : 'Continue'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
