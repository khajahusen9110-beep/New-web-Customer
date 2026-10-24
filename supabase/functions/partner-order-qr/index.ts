import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Partner-side "scan to pay" for a cash-on-delivery order at the doorstep.
// action "create": makes a fixed-amount, single-use Razorpay UPI QR for the order the
//   delivery partner is assigned to. The amount always comes from the database.
// action "check": asks Razorpay whether that QR was paid and, if so, marks the order
//   paid and flips payment_method to 'upi' so no cash is added to the partner's ledger.
// The webhook (razorpay-webhook, qr_code.credited) does the same automatically; this is
// the on-demand fallback the app calls while the partner waits.
// The Razorpay Key Secret never leaves this function.

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT_PAISE = 5_000_000; // Rs 50,000 hard ceiling for one QR

type OrderRow = {
  id: string;
  order_number: string;
  customer_id: string;
  city_id: string;
  delivery_partner_id: string | null;
  total_amount: number;
  payment_status: string;
  payment_method: string;
  status: string;
};

// Marks the order paid-online from a captured Razorpay payment, once.
async function markPaid(admin: ReturnType<typeof createClient>, txnId: string, order: OrderRow, rawResponse: Record<string, unknown>, payment: Record<string, unknown>) {
  await admin.from("payment_transactions").update({
    status: "paid",
    raw_response: { ...(rawResponse ?? {}), payment: { id: payment.id, status: payment.status, method: payment.method, amount: payment.amount, vpa: payment.vpa ?? null, via: "partner_qr" } },
    updated_at: new Date().toISOString(),
  }).eq("id", txnId);
  // trg_sync_order_payment_status flips orders.payment_status to 'paid'. We also move the
  // method off 'cash' so the delivery-completion cash ledger entry is never created.
  await admin.from("orders").update({ payment_method: "upi" }).eq("id", order.id).eq("payment_status", "paid").neq("payment_method", "upi");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return reply({ error: "Please log in again." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const keyId = Deno.env.get("RAZORPAY_KEY_ID");
    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!keyId || !keySecret) {
      console.error("partner-order-qr: Razorpay secrets are not configured");
      return reply({ error: "Online payment is not available right now." }, 503);
    }

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return reply({ error: "Please log in again." }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => null);
    const action = body?.action === "check" ? "check" : "create";
    const orderId = typeof body?.order_id === "string" ? body.order_id.trim() : "";
    if (!UUID.test(orderId)) return reply({ error: "Invalid order." }, 400);

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    // Caller must be an active delivery partner.
    const { data: partner } = await admin.from("delivery_partners")
      .select("id").eq("user_id", userId).eq("is_active", true).maybeSingle();
    if (!partner) return reply({ error: "Not allowed." }, 403);

    const { data: order } = await admin.from("orders")
      .select("id, order_number, customer_id, city_id, delivery_partner_id, total_amount, payment_status, payment_method, status")
      .eq("id", orderId).maybeSingle<OrderRow>();
    if (!order) return reply({ error: "Order not found." }, 404);

    // The partner must be the one assigned to this order (directly or via an assignment).
    let owns = order.delivery_partner_id === partner.id;
    if (!owns) {
      const { data: asg } = await admin.from("delivery_assignments")
        .select("id").eq("order_id", order.id).eq("delivery_partner_id", partner.id)
        .in("status", ["assigned", "accepted", "picked_up", "out_for_delivery", "arrived_drop", "delivered"]).maybeSingle();
      owns = !!asg;
    }
    if (!owns) return reply({ error: "Not allowed." }, 403);

    const auth = "Basic " + btoa(`${keyId}:${keySecret}`);
    const expectedPaise = Math.round(Number(order.total_amount) * 100);

    // ---- action: check -------------------------------------------------------
    if (action === "check") {
      if (order.payment_status === "paid") return reply({ payment_status: "paid", order_number: order.order_number });
      const { data: txns } = await admin.from("payment_transactions")
        .select("id, provider_payment_id, status, raw_response")
        .eq("order_id", order.id).eq("provider", "razorpay").eq("method", "upi_qr")
        .order("created_at", { ascending: false }).limit(5);
      for (const t of txns ?? []) {
        const qrId = String((t.raw_response as { id?: string } | null)?.id ?? t.provider_payment_id ?? "");
        if (!qrId.startsWith("qr_")) continue;
        if (t.status === "paid") return reply({ payment_status: "paid", order_number: order.order_number });
        const res = await fetch(`https://api.razorpay.com/v1/payment/qr_codes/${qrId}/payments`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(15000) });
        const data = await res.json().catch(() => null);
        if (!res.ok || !Array.isArray(data?.items)) continue;
        const captured = data.items.find((p: Record<string, unknown>) => p.status === "captured" && Number(p.amount) === expectedPaise);
        if (captured) {
          await markPaid(admin, t.id, order, (t.raw_response as Record<string, unknown>) ?? {}, captured);
          return reply({ payment_status: "paid", order_number: order.order_number, changed: true });
        }
      }
      return reply({ payment_status: order.payment_status, order_number: order.order_number, changed: false });
    }

    // ---- action: create ------------------------------------------------------
    if (order.payment_status === "paid") return reply({ error: "This order is already paid." }, 409);
    if (["cancelled", "rejected"].includes(String(order.status))) return reply({ error: "This order was cancelled." }, 409);
    if (!Number.isFinite(expectedPaise) || expectedPaise < 100 || expectedPaise > MAX_AMOUNT_PAISE) {
      return reply({ error: "This order cannot be collected online." }, 400);
    }

    // Reuse an existing live QR for this order instead of spawning duplicates.
    const { data: existing } = await admin.from("payment_transactions")
      .select("id, provider_payment_id, status, raw_response")
      .eq("order_id", order.id).eq("provider", "razorpay").eq("method", "upi_qr").eq("status", "created")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const existingQr = existing?.raw_response as { id?: string; image_url?: string; status?: string } | null;
    if (existingQr?.id && existingQr.image_url && existingQr.status === "active") {
      return reply({ qr_id: existingQr.id, image_url: existingQr.image_url, amount: expectedPaise, order_number: order.order_number, payment_status: order.payment_status });
    }

    const rpRes = await fetch("https://api.razorpay.com/v1/payment/qr_codes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        type: "upi_qr",
        name: `Sndmart ${order.order_number}`.slice(0, 50),
        usage: "single_use",
        fixed_amount: true,
        payment_amount: expectedPaise,
        description: `Order ${order.order_number}`.slice(0, 120),
        close_by: Math.floor(Date.now() / 1000) + 30 * 60,
        notes: { sndmart_order_id: order.id, order_number: order.order_number },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const qr = await rpRes.json().catch(() => null);
    if (!rpRes.ok || !qr?.id || !qr?.image_url) {
      console.error("partner-order-qr: Razorpay QR create failed HTTP", rpRes.status, qr?.error?.description ?? "");
      return reply({ error: "Could not create the payment QR. Please try again." }, 502);
    }

    await admin.from("payment_transactions").insert({
      order_id: order.id,
      customer_id: order.customer_id,
      provider: "razorpay",
      provider_payment_id: qr.id,
      amount: order.total_amount,
      currency: "INR",
      status: "created",
      method: "upi_qr",
      raw_response: qr,
    });

    return reply({ qr_id: qr.id, image_url: qr.image_url, amount: expectedPaise, order_number: order.order_number, payment_status: order.payment_status });
  } catch (e) {
    console.error("partner-order-qr: unexpected error", e instanceof Error ? e.message : String(e));
    return reply({ error: "Could not process the request. Please try again." }, 500);
  }
});
