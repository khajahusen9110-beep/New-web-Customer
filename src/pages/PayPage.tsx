import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Payment page opened from the Android app ("Pay in browser"). It needs no login: the Razorpay order was made
 * by the server with the amount, so this page only opens Razorpay's checkout for it. Chrome lists the UPI apps
 * (PhonePe, Google Pay, Paytm ...) even on phones where the in-app payment screen does not. When the payment is
 * done the customer goes back to the app, which re-checks the payment by itself.
 */
const ORDER_RE = /^order_[A-Za-z0-9]{8,40}$/;
const KEY_RE = /^rzp_(live|test)_[A-Za-z0-9]{8,40}$/;
// Opens the installed Sndmart app (Chrome on Android understands intent:// links).
const OPEN_APP = 'intent://#Intent;package=in.sndmart.app;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end';

function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('load'));
    document.body.appendChild(s);
  });
}

export default function PayPage() {
  const [params] = useSearchParams();
  const orderId = params.get('o') ?? '';
  const key = params.get('k') ?? '';
  const label = (params.get('n') ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24);
  const valid = ORDER_RE.test(orderId) && KEY_RE.test(key);
  const [state, setState] = useState<'idle' | 'paid' | 'closed' | 'error'>('idle');
  const started = useRef(false);

  const pay = useCallback(async () => {
    if (!valid) return;
    setState('idle');
    try {
      await loadScript();
      const Razorpay = window.Razorpay;
      if (!Razorpay) throw new Error('load');
      const rzp = new Razorpay({
        key,
        order_id: orderId,
        name: 'Sndmart',
        description: label ? `Order ${label}` : 'Sndmart order',
        theme: { color: '#6236D9' },
        handler: () => setState('paid'),
        modal: { ondismiss: () => setState((s) => (s === 'paid' ? s : 'closed')) },
      });
      rzp.on('payment.failed', () => setState('closed'));
      rzp.open();
    } catch {
      setState('error');
    }
  }, [valid, key, orderId, label]);

  useEffect(() => {
    if (valid && !started.current) {
      started.current = true;
      void pay();
    }
  }, [valid, pay]);

  return (
    <div className="page">
      <div className="content-pad narrow stack" style={{ textAlign: 'center', paddingTop: 48 }}>
        <img src="/icon-192.png" alt="Sndmart" width={72} height={72} style={{ margin: '0 auto', borderRadius: 16 }} />
        {!valid ? (
          <>
            <h2>Payment link is not valid</h2>
            <p className="muted">Please go back to the Sndmart app and try again.</p>
          </>
        ) : state === 'paid' ? (
          <>
            <h2>Payment successful ✅</h2>
            <p className="muted">ಪಾವತಿ ಯಶಸ್ವಿಯಾಗಿದೆ. Sndmart app ಗೆ ಹಿಂತಿರುಗಿ, ನಿಮ್ಮ order update ಆಗುತ್ತದೆ.</p>
            <a className="btn btn-primary btn-lg w-full" href={OPEN_APP}>Back to Sndmart app</a>
          </>
        ) : (
          <>
            <h2>{label ? `Pay for order ${label}` : 'Pay for your order'}</h2>
            {state === 'closed' && <p className="muted">Payment not completed. You can try again.</p>}
            {state === 'error' && <p className="text-danger">Could not open the payment screen. Check your connection and try again.</p>}
            <button className="btn btn-primary btn-lg w-full" onClick={() => void pay()}>Pay now</button>
            <a className="btn btn-outline w-full" href={OPEN_APP}>Back to Sndmart app</a>
          </>
        )}
      </div>
    </div>
  );
}
