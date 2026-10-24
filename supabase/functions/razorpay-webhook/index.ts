import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Razorpay -> Sndmart webhook. Marks orders paid even if the app never sent the verification.
// Configure in Razorpay Dashboard -> Settings -> Webhooks with events: payment.captured,
// order.paid and qr_code.credited; set the same secret in Supabase secret RAZORPAY_WEBHOOK_SECRET.
//   payment.captured / order.paid : customer checkout (razorpay order_...).
//   qr_code.credited              : a delivery partner's door-step scan-to-pay QR (qr_...).

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
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
  if (!secret) { console.error("razorpay-webhook: RAZORPAY_WEBHOOK_SECRET not set"); return new Response("not configured", { status: 503 }); }

  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const expected = await hmacHex(secret, raw);
  if (!signature || !safeEqual(signature, expected)) return new Response("invalid signature", { status: 401 });

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const event = evt?.event;
  const payment = evt?.payload?.payment?.entity;
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // ---- Door-step QR paid (delivery partner collected online) --------------------
  if (event === "qr_code.credited") {
    const qr = evt?.payload?.qr_code?.entity;
    const qrId = String(qr?.id ?? "");
    if (!payment || payment.status !== "captured" || !qrId.startsWith("qr_")) return new Response("ignored", { status: 200 });

    const { data: txn } = await admin.from("payment_transactions")
      .select("id, order_id, status, raw_response").eq("provider", "razorpay").eq("provider_payment_id", qrId).maybeSingle();
    if (!txn) { console.warn("razorpay-webhook: unknown qr", qrId); return new Response("unknown qr", { status: 200 }); }
    if (txn.status === "paid") return new Response("already paid", { status: 200 });

    const { data: order } = await admin.from("orders").select("id, total_amount").eq("id", txn.order_id).maybeSingle();
    if (!order || Math.round(Number(order.total_amount) * 100) !== Number(payment.amount)) {
      console.error("razorpay-webhook: qr amount mismatch for", qrId);
      return new Response("amount mismatch", { status: 200 });
    }

    await admin.from("payment_transactions").update({
      status: "paid",
      raw_response: { ...(txn.raw_response ?? {}), payment: { id: payment.id, status: payment.status, method: payment.method, amount: payment.amount, vpa: payment.vpa ?? null, via: "qr_webhook" } },
      updated_at: new Date().toISOString(),
    }).eq("id", txn.id);
    // trg_sync_order_payment_status marks the order paid; move it off 'cash' so the
    // delivery-completion flow does not add this amount to the partner's cash ledger.
    await admin.from("orders").update({ payment_method: "upi" }).eq("id", order.id).eq("payment_status", "paid").neq("payment_method", "upi");
    return new Response("ok", { status: 200 });
  }

  // ---- Customer checkout payment (razorpay order) -------------------------------
  if (!payment || !["payment.captured", "order.paid"].includes(event)) return new Response("ignored", { status: 200 });
  if (payment.status !== "captured") return new Response("not captured", { status: 200 });

  const rpOrderId = String(payment.order_id ?? "");
  if (!rpOrderId.startsWith("order_")) return new Response("no order id", { status: 200 });

  const { data: txn } = await admin.from("payment_transactions")
    .select("id, order_id, status, raw_response").eq("provider", "razorpay").eq("provider_payment_id", rpOrderId).maybeSingle();
  if (!txn) { console.warn("razorpay-webhook: unknown razorpay order", rpOrderId); return new Response("unknown order", { status: 200 }); }
  if (txn.status === "paid") return new Response("already paid", { status: 200 });

  const { data: order } = await admin.from("orders").select("id, total_amount").eq("id", txn.order_id).maybeSingle();
  if (!order || Math.round(Number(order.total_amount) * 100) !== Number(payment.amount)) {
    console.error("razorpay-webhook: amount mismatch for", rpOrderId);
    return new Response("amount mismatch", { status: 200 });
  }

  await admin.from("payment_transactions").update({
    status: "paid",
    raw_response: { ...(txn.raw_response ?? {}), payment: { id: payment.id, status: payment.status, method: payment.method, amount: payment.amount, vpa: payment.vpa ?? null, via: "webhook" } },
    updated_at: new Date().toISOString(),
  }).eq("id", txn.id);
  // trg_sync_order_payment_status marks orders.payment_status = 'paid'
  return new Response("ok", { status: 200 });
});
