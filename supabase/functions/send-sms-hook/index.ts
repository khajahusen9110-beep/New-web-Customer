import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Supabase Auth "Send SMS" hook -> MSG91 (paid). Only Supabase Auth can call it (signed webhook).
// Every send goes through api_guard_check('sms_otp'): per-number cooldown and hourly/daily
// quota, global hourly/daily caps and the kill switch (api_guard_config.enabled).
// Never log the OTP, the phone number or MSG91's response body.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// Supabase Auth shows `message` to the user, so keep it free of provider details.
const hookError = (message: string, status: number) => json({ error: { http_code: status, message } }, status);

// Indian mobile numbers only (the apps only offer +91). Blocks international SMS pumping.
const INDIAN_MOBILE = /^91[6-9]\d{9}$/;

async function alertAdmins(text: string) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN_1");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID_1");
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.error("send-sms-hook: admin alert failed");
  }
}

Deno.serve(async (req) => {
  let data: { user?: { phone?: string }; sms?: { otp?: string } };
  try {
    let hookSecret = Deno.env.get("SEND_SMS_HOOK_SECRET");
    if (!hookSecret) {
      console.error("send-sms-hook: SEND_SMS_HOOK_SECRET is not configured");
      return hookError("SMS service is not available right now. Please try again later.", 500);
    }
    if (hookSecret.startsWith("v1,")) hookSecret = hookSecret.slice(3);
    const payload = await req.text();
    data = new Webhook(hookSecret).verify(payload, Object.fromEntries(req.headers)) as typeof data;
  } catch {
    console.error("send-sms-hook: rejected request with an invalid webhook signature");
    return hookError("Unauthorized", 401);
  }

  const phone = String(data?.user?.phone ?? "").replace(/\D/g, "");
  const otp = String(data?.sms?.otp ?? "");
  if (!INDIAN_MOBILE.test(phone)) {
    return hookError("Please enter a valid Indian mobile number.", 400);
  }
  if (!/^\d{4,10}$/.test(otp)) {
    console.error("send-sms-hook: unexpected OTP format");
    return hookError("Could not send OTP right now. Please try again.", 500);
  }

  // Rate limits / quotas / kill switch. If the check itself fails, log it and still send, so a
  // database hiccup cannot lock every user out of login.
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const { data: guard, error } = await admin.rpc("api_guard_check", { p_endpoint: "sms_otp", p_subject: phone });
    if (error) {
      console.error("send-sms-hook: guard check failed:", error.code ?? "unknown");
    } else {
      if (guard?.alert) {
        await alertAdmins(
          `⚠️ Sndmart OTP SMS alert: ${guard.alert}. Sent this hour: ${guard.hourly_count}, today: ${guard.daily_count}. ` +
            `Check api_usage_hourly; set api_guard_config.enabled = false for 'sms_otp' to stop SMS.`,
        );
      }
      if (!guard?.allowed) {
        return hookError(guard?.message ?? "Too many OTP requests. Please try again later.", 429);
      }
    }
  } catch {
    console.error("send-sms-hook: guard check threw");
  }

  const authKey = Deno.env.get("MSG91_AUTH_KEY");
  const templateId = Deno.env.get("MSG91_TEMPLATE_ID");
  if (!authKey || !templateId) {
    console.error("send-sms-hook: MSG91 secrets are not configured");
    return hookError("SMS service is not available right now. Please try again later.", 500);
  }

  try {
    const res = await fetch("https://control.msg91.com/api/v5/flow", {
      method: "POST",
      headers: { authkey: authKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: templateId,
        short_url: "0",
        recipients: [{ mobiles: phone, OTP: otp }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    // Drain the body without logging it (it can echo the number).
    await res.text().catch(() => "");
    if (!res.ok) {
      console.error("send-sms-hook: MSG91 returned HTTP", res.status);
      return hookError("Could not send OTP right now. Please try again.", 500);
    }
  } catch {
    console.error("send-sms-hook: MSG91 request failed");
    return hookError("Could not send OTP right now. Please try again.", 500);
  }

  return json({});
});
