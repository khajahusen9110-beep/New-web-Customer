# Security & paid-API protection

## Where money can be spent

| Service | Paid? | Called from | Protection |
|---|---|---|---|
| MSG91 SMS (login OTP) | **Yes, per SMS** | `send-sms-hook` Edge Function, only via Supabase Auth (signed webhook) | Indian numbers only, per-number cooldown + hourly/daily quota, global hourly/daily cap, kill switch, alerts, CAPTCHA (optional) |
| Razorpay | Fee per successful payment only | `create-razorpay-order`, `verify-razorpay-payment` (login required) | Per-user + per-IP limits, amount taken from DB (max Rs 50,000), payment must match the order, kill switch |
| Telegram bot | Free | `send-telegram-order-alert` (DB trigger) | Order must exist and be new, one alert per order, text built from DB values |
| Firebase Cloud Messaging | Free | `send-fcm-*` (DB triggers) | Needs the device token, which only the database knows |
| Google Maps (maps, Places search, Geocoding) | **Yes, per map load / search / lookup** | Browser (only when `VITE_GOOGLE_MAPS_API_KEY` is set) | Restricted browser key + daily quotas + budget (below); 400 ms debounce, 3+ letters, India only, session tokens, reverse-geocode cache; falls back to OpenStreetMap if Google rejects the key |
| OpenStreetMap tiles / Nominatim | Free (fair-use) | Browser (fallback) | Debounced search; no key |
| Supabase | Plan + usage | Browser (anon key, RLS) | RLS on every table; set a spend cap |

The browser only has the Supabase URL and the **anon** key (public by design; RLS decides
access) and, optionally, the public Turnstile site key. All provider secrets (MSG91, Razorpay,
Firebase, Telegram, service role) exist only as Supabase Edge Function secrets.

## Emergency kill switch

Run in Supabase → SQL Editor. It takes effect on the next request.

```sql
-- Stop all OTP SMS (nobody can log in by OTP until turned back on)
update api_guard_config set enabled = false, updated_at = now() where endpoint = 'sms_otp';
-- Stop online payments (COD keeps working)
update api_guard_config set enabled = false, updated_at = now() where endpoint = 'razorpay_create_order';
-- Turn back on
update api_guard_config set enabled = true, updated_at = now() where endpoint in ('sms_otp', 'razorpay_create_order');
```

## Limits (table `api_guard_config`)

| endpoint | cooldown | per subject / hour | per subject / day | global / hour | global / day | alert at / hour |
|---|---|---|---|---|---|---|
| `sms_otp` (per phone) | 30 s | 5 | 10 | 300 | 2000 | 100 |
| `razorpay_create_order` (per user) | 3 s | 20 | 60 | 600 | 5000 | 300 |
| `razorpay_create_order_ip` (per IP) | – | 60 | 300 | – | – | – |
| `razorpay_verify` (per user) | – | 30 | 100 | 1000 | 10000 | – |
| `telegram_order_alert` (per order) | – | – | 1 | 300 | 3000 | 200 |

Change any value with an `update api_guard_config set ... where endpoint = '...'`. Anonymous
visitors can only reach `sms_otp` (limited per phone here, per IP by Supabase Auth's own rate
limits and CAPTCHA); everything else requires a signed-in user.

## Usage dashboard

Only super admins can read these (RLS). In the SQL Editor:

```sql
-- Last 24 hours, per endpoint and hour
select * from api_usage_hourly where hour > now() - interval '24 hours' order by hour desc, endpoint;
-- Daily totals and estimated SMS cost (Rs)
select * from api_usage_daily order by day desc, endpoint;
-- Why requests were blocked today
select endpoint, reason, count(*) from api_usage_log
 where not allowed and created_at > now() - interval '1 day' group by 1, 2 order by 3 desc;
-- Alerts raised
select * from api_usage_alerts order by created_at desc limit 50;
```

The log stores endpoint, time, allowed/blocked, reason, estimated cost and a keyed hash of the
phone/user/IP (HMAC with a private pepper), never the phone number, OTP or tokens. Rows older
than 90 days are deleted daily (pg_cron job `api-usage-log-cleanup`).

**Alerts:** when OTP sends cross the hourly alert threshold, or any global cap is hit, the first
Telegram bot/chat (`TELEGRAM_BOT_TOKEN_1` / `TELEGRAM_CHAT_ID_1`) gets a message (once per hour).

## CAPTCHA for OTP (recommended)

1. Cloudflare dashboard → Turnstile → add the site → copy the **site key** and **secret key**.
2. Supabase → Authentication → Attack Protection → enable CAPTCHA, provider Turnstile, paste the
   **secret key**.
3. Hosting env var: `VITE_TURNSTILE_SITE_KEY=<site key>` and redeploy the website.
   Do step 3 before or together with step 2: once CAPTCHA is on in Supabase, apps that do not
   send a token (including the Android apps) can no longer request OTPs.

## Google Maps key (must be restricted)

The Maps JavaScript API always runs in the browser, so this key is visible in the page by
design. What protects it is the restriction, not secrecy:

1. Google Cloud Console → APIs & Services → Credentials → Create credentials → API key.
2. **Application restrictions:** Websites → add `https://your-domain.com/*` (and
   `https://*.vercel.app/*` or your preview domain only if you need it).
3. **API restrictions:** Restrict key → only **Maps JavaScript API**, **Places API (New)**,
   **Geocoding API**. Enable just these three APIs in the project.
4. **Quotas** (APIs & Services → each API → Quotas): set a per-day cap, e.g. Maps JavaScript
   map loads 2,000/day, Places Autocomplete 3,000/day, Place Details 1,000/day, Geocoding
   1,000/day. Raise them as real traffic grows.
5. **Billing → Budgets & alerts:** a monthly budget (e.g. Rs 1,000) with email alerts at 50%,
   90%, 100%.
6. Put the key in the hosting env var `VITE_GOOGLE_MAPS_API_KEY` and redeploy. Do not reuse the
   Android app's Maps key (that one is restricted to the Android app).

If the key is missing, wrong, over quota or billing is off, the website switches to
OpenStreetMap automatically.

## Provider-side settings to configure

- **Supabase:** Organization → Billing → keep **Spend cap** on. Authentication → Rate Limits:
  SMS per hour (e.g. 100), OTP resend interval ≥ 60 s. Auth → Providers → Phone: OTP expiry
  ≤ 300 s. Enable leaked-password protection.
- **MSG91:** low-balance alert, daily sending limit, disable international SMS, keep DLT
  template-only sending, rotate the auth key if it was ever shared.
- **Razorpay:** use live keys only in Supabase secrets; enable webhooks for `payment.captured`
  as a backup confirmation; turn on account alerts; rotate keys if exposed.
- **Firebase:** the service accounts used for FCM should only have the "Firebase Cloud Messaging
  API Admin" role; disable unused Google Cloud APIs; set a budget alert in Google Cloud Billing.
- **Telegram:** bot tokens only in Supabase secrets; revoke via @BotFather if leaked.
- **GitHub:** keep repos private, enable secret scanning + push protection. Never commit
  `.env`, keystores, service-account JSON or the service-role key.

## Database hardening done (migrations in `supabase/migrations/`)

- `20260927160000_paid_api_guard.sql`: limits, quotas, kill switch, usage log, alerts; removed
  public access to `notify_city_admins` (fake admin notifications), `check_rate_limit` and, for
  logged-out visitors, `get_city_admin_assignment`.
- `20260927170000_block_role_self_escalation.sql`: users could change `profiles.role` on their
  own row and become super admin; vendors could change their own commission/approval. Only
  admins (or the city admin, where the apps already allow it) can change those now.
