import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Sends a Telegram message to the City Admin team when a new order is placed.
// Called by the trg_send_telegram_new_order database trigger with the public anon key, so the
// request body is NOT trusted: the order is looked up in the database (it must exist and be a
// few minutes old at most), the message is built from database values only, and each order is
// announced once (api_guard_check 'telegram_order_alert'). A forged call can therefore neither
// invent orders nor repeat alerts.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const MAX_ORDER_AGE_MS = 15 * 60 * 1000;

async function sendTelegramMessage(botToken: string, chatId: string, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    signal: AbortSignal.timeout(8000),
  });
  await res.text().catch(() => "");
  return res.ok;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json().catch(() => null);
    const orderNumber = typeof body?.order_number === "string" ? body.order_number.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(orderNumber)) return json({ error: "Invalid request" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    const { data: order } = await admin
      .from("orders")
      .select("order_number, total_amount, created_at, city_id")
      .eq("order_number", orderNumber)
      .maybeSingle();
    if (!order || Date.now() - Date.parse(order.created_at) > MAX_ORDER_AGE_MS) {
      return json({ error: "Invalid request" }, 400);
    }

    const { data: guard, error: guardErr } = await admin.rpc("api_guard_check", {
      p_endpoint: "telegram_order_alert",
      p_subject: orderNumber,
    });
    if (guardErr) console.error("send-telegram-order-alert: guard check failed:", guardErr.code ?? "unknown");
    else if (!guard?.allowed) return json({ success: true, skipped: guard?.reason }); // already announced / stopped

    let cityName = "Sindhanur";
    if (order.city_id) {
      const { data: city } = await admin.from("cities").select("name").eq("id", order.city_id).maybeSingle();
      if (city?.name) cityName = city.name;
    }

    const text =
      `🔔 <b>New Order Received!</b>\n\n` +
      `Order: <b>${escapeHtml(order.order_number)}</b>\n` +
      `Amount: ₹${Number(order.total_amount ?? 0).toFixed(2)}\n` +
      `City: ${escapeHtml(cityName)}`;

    const results: { member: number; ok: boolean }[] = [];
    for (const member of [1, 2]) {
      const token = Deno.env.get(`TELEGRAM_BOT_TOKEN_${member}`);
      const chatId = Deno.env.get(`TELEGRAM_CHAT_ID_${member}`);
      if (token && chatId) {
        const ok = await sendTelegramMessage(token, chatId, text).catch(() => false);
        if (!ok) console.error("send-telegram-order-alert: Telegram send failed for member", member);
        results.push({ member, ok });
      }
    }
    return json({ success: true, results });
  } catch {
    console.error("send-telegram-order-alert: unexpected error");
    return json({ error: "Internal error" }, 500);
  }
});
