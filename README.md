# Sndmart Customer Web

Web version of the **Sndmart** Android customer app (Kotlin + Jetpack Compose), rebuilt in
**React 18 + TypeScript + Vite**. It talks to the **same Supabase backend** (same tables, RPCs and
edge functions), so customers, carts, addresses and orders are shared with the mobile app.

## Run locally

```bash
npm install
cp .env.example .env      # Supabase URL + public anon key
npm run dev               # http://localhost:5173
```

| Script              | What it does                          |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Dev server with hot reload            |
| `npm run typecheck` | TypeScript check                      |
| `npm run build`     | Type check + production build → `dist/` |
| `npm run preview`   | Serve the production build locally    |

## Deploy

It is a static single-page app. Build with `npm run build` and host `dist/` anywhere.

- **Vercel**: import the repo, set the two `VITE_SUPABASE_*` env vars. `vercel.json` already
  rewrites all routes to `index.html`.
- **Netlify**: build command `npm run build`, publish directory `dist`, same env vars, plus a
  redirect rule `/*  /index.html  200` for SPA routing.

**Google Maps:** set `VITE_GOOGLE_MAPS_API_KEY` (a restricted browser key, see SECURITY.md) to use Google Maps
for maps, place search and address lookup everywhere; without it the site uses OpenStreetMap.

**Security / paid APIs:** see [SECURITY.md](SECURITY.md) for the kill switch, usage dashboard, limits and
provider settings (MSG91, Razorpay, Firebase, Supabase spend cap, CAPTCHA).

**SEO**

Set `VITE_SITE_URL` (e.g. `https://sndmart.in`) in the hosting env vars. The build then fills the
canonical, Open Graph and structured-data URLs in `index.html` and writes `robots.txt` and
`sitemap.xml` (the Vercel/Netlify production URL is used if it is not set). Only the home/login
page is indexed; pages behind login are blocked in `robots.txt` and marked `noindex`. After going
live, add the site in Google Search Console and submit `/sitemap.xml`.

- **Cloudflare Workers** (Workers & Pages → Create → Import a repository): build command
  `npm run build`, deploy command `npx wrangler deploy`. `wrangler.jsonc` serves `dist/` with SPA
  routing; its `name` must match the Worker's name in the dashboard. Add the `VITE_*` variables
  under Settings → Build → Variables and secrets (they are needed at build time).
- **Cloudflare Pages**: Workers & Pages → Create → Pages → Connect to Git → pick this repo, branch
  `main`. Framework preset **Vite** (or None), build command `npm run build`, output directory
  `dist`. Environment variables (Production): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_SITE_URL` (your domain), `NODE_VERSION=22`, plus optional `VITE_GOOGLE_MAPS_API_KEY` /
  `VITE_TURNSTILE_SITE_KEY`. SPA routing works out of the box (no `404.html`); `public/_headers`
  sets caching and security headers.

**Supabase settings to check before going live**

1. *Authentication → URL Configuration*: add your web domain to the allowed site / redirect URLs.
2. Phone OTP (SMS provider) must stay enabled — the web app logs in with the same phone + OTP flow.
3. UPI payments call the existing `create-razorpay-order` / `verify-razorpay-payment` edge
   functions from the browser; they already send `Access-Control-Allow-Origin: *`, so no change
   is needed (keep it that way if you edit them).

## Speed

- **Instant start:** returning customers see the app at once; profile, cart and maintenance checks
  finish in the background. The last-seen home lists (categories, first page of products and
  hotels, featured rows, hotel hours, menus) are kept on the device and shown immediately, then
  replaced by fresh data (stale-while-revalidate). Cart and checkout always re-check live prices.
- **Smart pagination:** the next page is fetched while the browser is idle, and the list asks for
  more 1200 px before the end, so scrolling does not wait. The other grocery category is
  prefetched; a hotel's menu starts loading when the finger touches its card.
- **Images:** Supabase Storage images are served resized as WebP through Supabase image
  transformation (Pro plan; billed per distinct source image after the included quota). Set
  `VITE_IMAGE_TRANSFORM=false` to serve originals; a resized image that fails falls back to the original.
- **Database:** customer RLS checks run once per query (`20261005120000_faster_customer_rls.sql`).

## Screens (mobile → web)

| Android screen                 | Web route            |
| ------------------------------ | -------------------- |
| AuthScreen (phone → OTP → name) | `/auth`             |
| LocationOnboardingScreen       | `/onboarding`        |
| HomeScreen (groceries / hotels) | `/` and `/?mode=hotels` |
| HotelMenuScreen                | `/hotel/:vendorId`   |
| CartScreen                     | `/cart`              |
| CheckoutScreen                 | `/checkout/grocery`, `/checkout/hotel` |
| OrdersScreen                   | `/orders`            |
| OrderDetailScreen (live tracking) | `/orders/:orderId` |
| ProfileScreen                  | `/profile`           |
| EditProfileScreen              | `/profile/edit`      |
| AddressBookScreen              | `/addresses`         |
| NotificationsScreen            | `/notifications`     |
| WalletScreen                   | `/wallet`            |
| MyReviewsScreen                | `/reviews`           |
| HelpSupportScreen              | `/help`              |
| MaintenanceScreen              | shown automatically  |
| CityPickerModal / LocationRequirementDialog | global modals |

Business rules kept from the app: fresh city prices on every cart render, single-hotel cart,
backend-authoritative checkout RPCs (`checkout_grocery_order` / `checkout_food_order`), coupon
validation, scheduled vs express delivery fees, maintenance-mode check before checkout, single-device
login (logging in on the web signs the account out on other devices, just like the app), order
polling every 18 s with live rider map, reorder, ratings, wallet and notifications.

## Web-specific differences

- **Maps**: OpenStreetMap + Leaflet (map, pin drag) and Nominatim (search / reverse geocoding) —
  no Google Maps API key needed.
- **Location**: browser Geolocation API; if permission is denied the user can still set the
  address manually.
- **Payments**: Razorpay Checkout.js (UPI only, same edge functions).
- **Push notifications**: FCM device tokens are not registered from the web; the unread count is
  refreshed when the tab regains focus and on the notifications page.
- **App-version force update** is not applied to the web (it only makes sense for store builds).
- **Cart**: also cached in `localStorage`, so a page refresh never loses cart changes.

## Project structure

```
src/
  lib/          supabase client, repository (all queries/RPCs), types, utils, geo, razorpay, hooks
  store/        session + cart state (zustand)
  components/   UI kit, layout/nav, map, address picker, city picker
  pages/        one file per screen
```
