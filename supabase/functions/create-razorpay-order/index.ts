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
// Hard ceiling for one UPI payment, whatever the order says.
const MAX_AMOUNT_PAISE = 5_000_000; // Rs 50,000

// Creates a Razorpay Order for an existing Sndmart order, restricted to UPI.
// The Razorpay Key Secret never leaves this function; the amount always comes from the database.
// Errors returned to the client are generic; details only go to the function log.
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
    const orderId = typeof body?.order_id === "string" ? body.order_id.trim() : "";
    if (!UUID.test(orderId)) return reply({ error: "Invalid order." }, 400);

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    // Per-user and per-IP limits + kill switch (api_guard_config 'razorpay_create_order*').
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    const checks = [admin.rpc("api_guard_check", { p_endpoint: "razorpay_create_order", p_subject: userId, p_user_id: userId })];
    if (ip) checks.push(admin.rpc("api_guard_check", { p_endpoint: "razorpay_create_order_ip", p_subject: ip, p_user_id: userId }));
    for (const { data: guard, error } of await Promise.all(checks)) {
      if (error) console.error("create-razorpay-order: guard check failed:", error.code ?? "unknown");
      else if (!guard?.allowed) return reply({ error: guard?.message ?? "Too many requests. Please try again later." }, 429);
    }

    const { data: order, error: orderErr } = await admin
      .from("orders")
      .select("id, customer_id, total_amount, payment_status, status")
      .eq("id", orderId)
      .maybeSingle();
    if (orderErr || !order || order.customer_id !== userId) return reply({ error: "Order not found." }, 404);
    if (order.payment_status === "paid") return reply({ error: "This order is already paid." }, 409);
    if (["cancelled", "rejected"].includes(String(order.status))) return reply({ error: "This order was cancelled." }, 409);

    const amountPaise = Math.round(Number(order.total_amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < 100 || amountPaise > MAX_AMOUNT_PAISE) {
      console.error("create-razorpay-order: amount out of range for order", order.id);
      return reply({ error: "This order cannot be paid online. Please contact support." }, 400);
    }

    const keyId = Deno.env.get("RAZORPAY_KEY_ID");
    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!keyId || !keySecret) {
      console.error("create-razorpay-order: Razorpay secrets are not configured");
      return reply({ error: "Online payment is not available right now." }, 503);
    }

    const rpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${keyId}:${keySecret}`) },
      body: JSON.stringify({ amount: amountPaise, currency: "INR", receipt: order.id, notes: { sndmart_order_id: order.id } }),
      signal: AbortSignal.timeout(15000),
    });
    const rpBody = await rpRes.json().catch(() => null);
    if (!rpRes.ok || !rpBody?.id) {
      console.error("create-razorpay-order: Razorpay returned HTTP", rpRes.status);
      return reply({ error: "Could not start payment. Please try again." }, 502);
    }

    await admin.from("payment_transactions").insert({
      order_id: order.id,
      customer_id: userId,
      provider: "razorpay",
      provider_payment_id: rpBody.id,
      amount: order.total_amount,
      currency: "INR",
      status: "created",
      method: "upi",
      raw_response: rpBody,
    });

    return reply({
      razorpay_order_id: rpBody.id,
      amount: amountPaise,
      currency: "INR",
      key_id: keyId, // public key id, safe for the checkout form
    });
  } catch {
    console.error("create-razorpay-order: unexpected error");
    return reply({ error: "Could not start payment. Please try again." }, 500);
  }
});
