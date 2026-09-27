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
- **Netlify**: build command `npm run build`, publish directory `dist`, same env vars.
  `public/_redirects` handles SPA routing.

**Supabase settings to check before going live**

1. *Authentication → URL Configuration*: add your web domain to the allowed site / redirect URLs.
2. Phone OTP (SMS provider) must stay enabled — the web app logs in with the same phone + OTP flow.
3. UPI payments call the existing `create-razorpay-order` / `verify-razorpay-payment` edge
   functions from the browser; they already send `Access-Control-Allow-Origin: *`, so no change
   is needed (keep it that way if you edit them).

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
