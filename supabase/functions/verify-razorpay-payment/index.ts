import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RZP_ID = /^[A-Za-z0-9_]{6,40}$/;
const HEX64 = /^[0-9a-f]{64}$/i;

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Verifies a Razorpay payment SERVER-SIDE before marking an order as paid:
// 1. the signature proves Razorpay authorised this payment for `razorpay_order_id`;
// 2. that Razorpay order must be the one created for THIS Sndmart order (by
//    create-razorpay-order, which set its amount from the database), so a cheap order's
//    payment can never be replayed onto a different, more expensive order.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return reply({ error: "Please log in again." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return reply({ error: "Please log in again." }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => null);
    const orderId = String(body?.order_id ?? "").trim();
    const rzpOrderId = String(body?.razorpay_order_id ?? "").trim();
    const rzpPaymentId = String(body?.razorpay_payment_id ?? "").trim();
    const signature = String(body?.razorpay_signature ?? "").trim();
    if (!UUID.test(orderId) || !RZP_ID.test(rzpOrderId) || !RZP_ID.test(rzpPaymentId) || !HEX64.test(signature)) {
      return reply({ error: "Invalid payment details." }, 400);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const { data: guard, error: guardErr } = await admin.rpc("api_guard_check", {
      p_endpoint: "razorpay_verify",
      p_subject: userId,
      p_user_id: userId,
    });
    if (guardErr) console.error("verify-razorpay-payment: guard check failed:", guardErr.code ?? "unknown");
    else if (!guard?.allowed) return reply({ error: guard?.message ?? "Too many requests. Please try again later." }, 429);

    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!keySecret) {
      console.error("verify-razorpay-payment: RAZORPAY_KEY_SECRET is not configured");
      return reply({ error: "Payment could not be confirmed right now." }, 503);
    }

    const expected = await hmacSha256Hex(keySecret, `${rzpOrderId}|${rzpPaymentId}`);
    if (!timingSafeEqual(expected, signature.toLowerCase())) {
      return reply({ error: "Signature verification failed — payment could not be confirmed" }, 400);
    }

    const { data: order, error: orderErr } = await admin
      .from("orders")
      .select("id, customer_id, total_amount, payment_status")
      .eq("id", orderId)
      .maybeSingle();
    if (orderErr || !order || order.customer_id !== userId) return reply({ error: "Order not found." }, 404);
    if (order.payment_status === "paid") return reply({ success: true }); // already confirmed (retry)

    // The Razorpay order must have been created for this Sndmart order, for its full amount.
    const { data: txns } = await admin
      .from("payment_transactions")
      .select("id, raw_response")
      .eq("order_id", orderId)
      .eq("provider", "razorpay");
    const created = (txns ?? []).find((t) => (t.raw_response as { id?: string } | null)?.id === rzpOrderId);
    const expectedPaise = Math.round(Number(order.total_amount) * 100);
    const createdPaise = Number((created?.raw_response as { amount?: number } | null)?.amount);
    if (!created || createdPaise !== expectedPaise) {
      console.error("verify-razorpay-payment: razorpay order does not match order", orderId);
      return reply({ error: "Payment does not match this order. Please contact support." }, 400);
    }

    await admin.from("orders").update({ payment_status: "paid", payment_method: "upi" }).eq("id", orderId);
    await admin
      .from("payment_transactions")
      .update({ status: "paid", provider_payment_id: rzpPaymentId })
      .eq("id", created.id);
    await admin.from("payments").insert({
      order_id: orderId,
      method: "upi",
      status: "paid",
      amount: order.total_amount,
      transaction_id: rzpPaymentId,
      provider: "razorpay",
      paid_at: new Date().toISOString(),
    });

    return reply({ success: true });
  } catch {
    console.error("verify-razorpay-payment: unexpected error");
    return reply({ error: "Payment could not be confirmed right now." }, 500);
  }
});
