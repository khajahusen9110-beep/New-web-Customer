// Web replacement for RazorpayPaymentManager: loads Razorpay Checkout.js
// and opens it restricted to UPI, resolving with the payment result.
import type { RazorpayOrderResponse } from './types';

interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open: () => void;
  on: (event: string, cb: (resp: { error?: { description?: string } }) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance;
  }
}

export type RazorpayResult =
  | { kind: 'success'; paymentId: string; orderId: string; signature: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

let loader: Promise<void> | null = null;

function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loader = null;
        reject(new Error('Could not load the payment gateway. Check your connection.'));
      };
      document.body.appendChild(s);
    });
  }
  return loader;
}

export async function openUpiCheckout(p: {
  order: RazorpayOrderResponse;
  orderNumber: string;
  phone?: string | null;
  email?: string | null;
}): Promise<RazorpayResult> {
  await loadCheckoutScript();
  const Razorpay = window.Razorpay;
  if (!Razorpay) return { kind: 'error', message: 'Unable to open payment screen. Please try again.' };

  return new Promise((resolve) => {
    let settled = false;
    const done = (r: RazorpayResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const prefill: Record<string, string> = {};
    if (p.phone) prefill.contact = p.phone;
    if (p.email) prefill.email = p.email;

    const rzp = new Razorpay({
      key: p.order.keyId,
      amount: p.order.amount,
      currency: p.order.currency || 'INR',
      order_id: p.order.razorpayOrderId,
      name: 'Sndmart',
      description: `Order ${p.orderNumber}`,
      method: { upi: true, card: false, netbanking: false, wallet: false, paylater: false },
      prefill,
      theme: { color: '#6750A4' },
      handler: (resp: RazorpaySuccess) =>
        done({
          kind: 'success',
          paymentId: resp.razorpay_payment_id,
          orderId: resp.razorpay_order_id || p.order.razorpayOrderId,
          signature: resp.razorpay_signature,
        }),
      modal: { ondismiss: () => done({ kind: 'cancelled' }) },
    });
    rzp.on('payment.failed', (resp) =>
      done({ kind: 'error', message: resp.error?.description || 'Payment could not be completed.' }),
    );
    rzp.open();
  });
}
