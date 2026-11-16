import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Tiffin Pickup monthly auto-pay (Razorpay Subscriptions + UPI AutoPay).
//   create       customer: starts auto-pay for a plan that is waiting for payment. Returns what checkout needs.
//   verify       customer: after checkout, confirms the payment signature and activates the plan right away
//                (the webhook does the same later; both are safe to run twice).
//   sync         customer: re-checks with Razorpay what happened to a payment and applies it.
//   stop         customer: stops future monthly charges. Days already paid for keep running.
//   admin_cancel city admin: stops auto-pay at the bank, then cancels the plan.
// The Razorpay Key Secret never leaves this function; every amount comes from the database.

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = ["created", "authenticated", "active", "pending"];

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return reply({ error: "Please log in again." }, 401);
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return reply({ error: "Please log in again." }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => null);
    const action = String(body?.action ?? "");
    const subId = typeof body?.subscription_id === "string" ? body.subscription_id.trim() : "";
    if (!UUID.test(subId)) return reply({ error: "Invalid plan." }, 400);

    const keyId = Deno.env.get("RAZORPAY_KEY_ID");
    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!keyId || !keySecret) { console.error("tiffin-autopay: Razorpay secrets are not configured"); return reply({ error: "Online payment is not available right now." }, 503); }
    const rzpAuth = "Basic " + btoa(`${keyId}:${keySecret}`);
    const rzp = async (method: string, path: string, payload?: unknown) => {
      const res = await fetch(`https://api.razorpay.com/v1${path}`, {
        method, headers: { "Content-Type": "application/json", Authorization: rzpAuth },
        body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000),
      });
      const json = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, json };
    };

    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: sub } = await admin.from("tiffin_subscriptions").select("*").eq("id", subId).maybeSingle();
    if (!sub) return reply({ error: "Plan not found." }, 404);

    // Stops the monthly mandate at Razorpay. Returns an error text, or null when it is stopped.
    const stopAtRazorpay = async (atCycleEnd: boolean): Promise<string | null> => {
      if (!sub.razorpay_subscription_id || !LIVE.includes(sub.autopay_status)) return null;
      const r = await rzp("POST", `/subscriptions/${sub.razorpay_subscription_id}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
      if (r.ok) return null;
      const desc = String(r.json?.error?.description ?? "");
      // Already cancelled / completed there: nothing left to stop.
      if (/already|cancelled|completed|expired/i.test(desc)) return null;
      // A subscription that was never authorised cannot be cancelled and can never charge.
      if (sub.autopay_status === "created") return null;
      console.error("tiffin-autopay: cancel failed", r.status, desc);
      return "Could not stop auto-pay right now. Please try again.";
    };

    // ---------------------------------------------------------------- sync
    // Safety net for "money was taken but the plan did not start": asks Razorpay what really happened
    // to this plan's subscription and applies it (safe to run any number of times).
    if (action === "sync") {
      if (sub.customer_id !== userId) return reply({ error: "Plan not found." }, 404);
      if (!sub.razorpay_subscription_id) return reply({ ok: true, synced: false });
      const rs = await rzp("GET", `/subscriptions/${sub.razorpay_subscription_id}`);
      if (!rs.ok || !rs.json) return reply({ ok: true, synced: false });
      let applied = 0;
      const inv = await rzp("GET", `/invoices?subscription_id=${sub.razorpay_subscription_id}`);
      for (const i of (inv.json?.items ?? []) as any[]) {
        if (i?.status !== "paid" || typeof i.payment_id !== "string") continue;
        const { error: chargeErr } = await admin.rpc("tiffin_autopay_charged", {
          p_razorpay_subscription_id: sub.razorpay_subscription_id, p_payment_id: i.payment_id,
          p_amount_paise: Number(i.amount_paid ?? i.amount),
          p_raw: { invoice: i.id, status: i.status, amount: i.amount_paid ?? i.amount, via: "sync" },
        });
        if (!chargeErr) applied++;
      }
      const st = String(rs.json.status ?? "");
      if (["authenticated", "active", "pending", "halted", "cancelled", "completed"].includes(st)) {
        await admin.rpc("tiffin_autopay_event", { p_razorpay_subscription_id: sub.razorpay_subscription_id, p_event: st });
      }
      return reply({ ok: true, synced: true, razorpay_status: st, payments_applied: applied });
    }

    // ---------------------------------------------------------------- create
    if (action === "create") {
      if (sub.customer_id !== userId) return reply({ error: "Plan not found." }, 404);
      if (sub.status !== "pending_payment") return reply({ error: "This plan is not waiting for payment." }, 409);

      const { data: prepared, error: prepErr } = await admin.rpc("tiffin_prepare_autopay", { p_subscription_id: subId });
      if (prepErr || !prepared) { console.error("tiffin-autopay: prepare failed", prepErr?.code); return reply({ error: "Could not start payment. Please try again." }, 400); }
      const p = prepared as any;

      const monthlyPaise = Math.round(Number(p.total_amount) * 100);
      const trialPaise = Math.round(Number(p.trial_fee) * 100);
      if (!Number.isFinite(monthlyPaise) || monthlyPaise < 100 || monthlyPaise > 5_000_000) return reply({ error: "This plan cannot be paid online. Please contact support." }, 400);
      if (p.is_trial && (!Number.isFinite(trialPaise) || trialPaise < 100)) return reply({ error: "This plan cannot be paid online. Please contact support." }, 400);

      // A leftover un-authorised subscription from an earlier try is abandoned (it can never charge).
      // One Razorpay plan per monthly amount, created once and reused.
      let planId: string | null = null;
      const { data: planRow } = await admin.from("tiffin_razorpay_plans").select("razorpay_plan_id").eq("amount_paise", monthlyPaise).maybeSingle();
      if (planRow?.razorpay_plan_id) planId = planRow.razorpay_plan_id;
      else {
        const pr = await rzp("POST", "/plans", { period: "monthly", interval: 1, item: { name: `Sndmart Tiffin Pickup - Rs ${monthlyPaise / 100} per month`, amount: monthlyPaise, currency: "INR" } });
        if (!pr.ok || !pr.json?.id) { console.error("tiffin-autopay: plan failed", pr.status, pr.json?.error?.description); return reply({ error: "Could not start auto-pay. Please try again." }, 502); }
        planId = pr.json.id;
        await admin.from("tiffin_razorpay_plans").upsert({ amount_paise: monthlyPaise, razorpay_plan_id: planId });
      }

      const payload: Record<string, unknown> = {
        plan_id: planId, total_count: 60, quantity: 1, customer_notify: 1,
        notes: { tiffin_subscription_id: p.id, kind: "tiffin_pickup" },
      };
      if (p.is_trial) {
        // First real charge: 00:30 India time on the day after the trial ends. Only the trial fee is taken now.
        const [y, m, d] = String(p.trial_end_date).split("-").map(Number);
        const startAt = Math.floor((Date.UTC(y, m - 1, d + 1, 0, 30) - 5.5 * 3600 * 1000) / 1000);
        if (startAt < Math.floor(Date.now() / 1000) + 3600) return reply({ error: "Please choose a later start date." }, 400);
        payload.start_at = startAt;
        payload.addons = [{ item: { name: `${p.trial_days}-day tiffin trial`, amount: trialPaise, currency: "INR" } }];
      }
      const sr = await rzp("POST", "/subscriptions", payload);
      if (!sr.ok || !sr.json?.id) { console.error("tiffin-autopay: subscription failed", sr.status, sr.json?.error?.description); return reply({ error: "Could not start auto-pay. Please try again." }, 502); }
      let firstCharge: string | null = null;
      if (p.is_trial) {
        const [y, m, d] = String(p.trial_end_date).split("-").map(Number);
        firstCharge = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
      }
      await admin.rpc("tiffin_set_razorpay_subscription", { p_subscription_id: subId, p_razorpay_subscription_id: sr.json.id });
      return reply({
        razorpay_subscription_id: sr.json.id, key_id: keyId, is_trial: !!p.is_trial,
        pay_now: p.is_trial ? trialPaise / 100 : monthlyPaise / 100, monthly: monthlyPaise / 100,
        first_charge_date: firstCharge,
        // Razorpay's hosted payment page for this subscription (lists UPI apps in the browser): a fallback for phones whose
        // in-app payment screen does not list UPI.
        short_url: typeof sr.json.short_url === "string" ? sr.json.short_url : null,
      });
    }

    // ---------------------------------------------------------------- verify
    if (action === "verify") {
      if (sub.customer_id !== userId) return reply({ error: "Plan not found." }, 404);
      const paymentId = String(body?.razorpay_payment_id ?? "");
      const rzpSubId = String(body?.razorpay_subscription_id ?? "");
      const signature = String(body?.razorpay_signature ?? "");
      if (!paymentId.startsWith("pay_") || !rzpSubId.startsWith("sub_") || !signature) return reply({ error: "Invalid payment." }, 400);
      if (rzpSubId !== sub.razorpay_subscription_id) return reply({ error: "Invalid payment." }, 400);
      const expected = await hmacHex(keySecret, `${paymentId}|${rzpSubId}`);
      if (!safeEqual(signature, expected)) return reply({ error: "Payment could not be verified." }, 400);

      const pay = await rzp("GET", `/payments/${paymentId}`);
      if (!pay.ok || !pay.json || !["captured", "authorized"].includes(pay.json.status)) {
        // Signature was valid but the payment is not final yet: the webhook will finish the job.
        return reply({ ok: true, pending: true });
      }
      const { error: chargeErr } = await admin.rpc("tiffin_autopay_charged", {
        p_razorpay_subscription_id: rzpSubId, p_payment_id: paymentId, p_amount_paise: pay.json.amount,
        p_raw: { id: pay.json.id, status: pay.json.status, method: pay.json.method, amount: pay.json.amount, via: "verify" },
      });
      if (chargeErr) { console.error("tiffin-autopay: charged rpc failed", chargeErr.code); return reply({ ok: true, pending: true }); }
      return reply({ ok: true });
    }

    // ---------------------------------------------------------------- stop (customer)
    if (action === "stop") {
      if (sub.customer_id !== userId) return reply({ error: "Plan not found." }, 404);
      if (!["active", "paused"].includes(sub.status)) return reply({ error: "This plan is not running." }, 409);
      if (!LIVE.includes(sub.autopay_status)) return reply({ ok: true, already: true });
      const err = await stopAtRazorpay(sub.billing_cycles_paid > 0);
      if (err) return reply({ error: err }, 502);
      await admin.rpc("tiffin_mark_autopay_stopped", { p_subscription_id: subId, p_reason: "Auto-pay stopped by customer" });
      return reply({ ok: true, runs_until: sub.end_date });
    }

    // ---------------------------------------------------------------- admin cancel
    if (action === "admin_cancel") {
      const [{ data: isCity }, { data: isSuper }] = await Promise.all([
        userClient.rpc("is_city_admin_for", { target_city_id: sub.city_id }),
        userClient.rpc("is_super_admin"),
      ]);
      if (!isCity && !isSuper) return reply({ error: "Not allowed." }, 403);
      if (["completed", "cancelled"].includes(sub.status)) return reply({ error: "This plan has already ended." }, 409);
      const err = await stopAtRazorpay(false);
      if (err) return reply({ error: err }, 502);
      await admin.rpc("tiffin_mark_autopay_stopped", { p_subscription_id: subId, p_reason: String(body?.reason ?? "") });
      const { error: cancelErr } = await userClient.rpc("tiffin_admin_action", { p_subscription_id: subId, p_action: "cancel", p_partner_id: null, p_reason: String(body?.reason ?? "") || null });
      if (cancelErr) return reply({ error: cancelErr.message }, 400);
      return reply({ ok: true });
    }

    return reply({ error: "Unknown action." }, 400);
  } catch (e) {
    console.error("tiffin-autopay: unexpected error", String(e));
    return reply({ error: "Something went wrong. Please try again." }, 500);
  }
});
