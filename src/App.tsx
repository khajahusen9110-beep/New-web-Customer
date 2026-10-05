import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { IosInstallPrompt } from './components/IosInstallPrompt';
import { AndroidAppPrompt } from './components/AndroidAppPrompt';
import { useRouteSeo } from './lib/seo';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import {
  checkMaintenanceMode,
  checkStillActiveDevice,
  getAddresses,
  refreshUnreadNotificationCount,
  resolveUserCity,
  syncPendingUpiOrders,
} from './lib/repository';
import { useSession } from './store/session';
import { useCart } from './store/cart';
import { CenterSpinner, ToastHost, toast } from './components/ui';
import { PlainLayout, TabLayout } from './components/Layout';
import { CityPickerModal, LocationDetectDialog } from './components/CityPicker';
import AuthPage from './pages/AuthPage';
import HomePage from './pages/HomePage';

// Login and home load with the app; every other page is downloaded the first time it is opened
// (and the main tabs are prefetched once the browser is idle, see prefetchTabs).
const LocationOnboardingPage = lazy(() => import('./pages/LocationOnboardingPage'));
const HotelMenuPage = lazy(() => import('./pages/HotelMenuPage'));
const CartPage = lazy(() => import('./pages/CartPage'));
const CheckoutPage = lazy(() => import('./pages/CheckoutPage'));
const OrdersPage = lazy(() => import('./pages/OrdersPage'));
const OrderDetailPage = lazy(() => import('./pages/OrderDetailPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const WalletPage = lazy(() => import('./pages/WalletPage'));
const MyReviewsPage = lazy(() => import('./pages/MyReviewsPage'));
const AddressBookPage = lazy(() => import('./pages/AddressBookPage'));
const EditProfilePage = lazy(() => import('./pages/EditProfilePage'));
const HelpSupportPage = lazy(() => import('./pages/HelpSupportPage'));

let tabsPrefetched = false;
/** Downloads the bottom-tab pages' code in the background so switching tabs stays instant. */
function prefetchTabs() {
  if (tabsPrefetched) return;
  tabsPrefetched = true;
  const run = () => {
    void import('./pages/CartPage');
    void import('./pages/OrdersPage');
    void import('./pages/ProfilePage');
    void import('./pages/HotelMenuPage');
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (idle) idle(run);
  else setTimeout(run, 2000);
}
import MaintenancePage from './pages/MaintenancePage';

/** Keeps the local session store in sync with the Supabase auth session. */
function useAuthSync() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const s = useSession.getState();
      if (!data.session) {
        if (s.isLoggedIn) s.logout();
      } else if (!s.userId || s.userId !== data.session.user.id) {
        s.saveSession({
          userId: data.session.user.id,
          email: data.session.user.email ?? null,
          phone: data.session.user.phone ? `+${data.session.user.phone.replace(/^\+/, '')}` : null,
        });
      }
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      // A refresh-token failure or remote sign-out ends the session here too.
      if (event === 'SIGNED_OUT' && useSession.getState().isLoggedIn) {
        useCart.getState().clearLocal();
        useSession.getState().notifySessionExpired();
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);
  return ready;
}

/** Post-login bootstrap: profile city, saved-address flag, cart, unread count, device checks. */
function useLoggedInEffects() {
  const userId = useSession((s) => s.userId);
  const [verified, setVerified] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setVerified(false);
    if (!userId) {
      setVerified(true);
      return;
    }
    (async () => {
      const s = useSession.getState();
      if (!s.selectedCity) {
        const city = await resolveUserCity(userId);
        if (city) s.setSelectedCity(city);
      }
      try {
        const addresses = await getAddresses(userId);
        if (addresses.length) {
          const def = addresses.find((a) => a.is_default) ?? addresses[0];
          s.setHasSavedAddress(true, def.label);
        } else {
          s.setHasSavedAddress(false);
        }
      } catch {
        /* keep the cached flag when offline */
      }
      await useCart.getState().hydrateForUser(userId);
      void refreshUnreadNotificationCount(userId);
      // A UPI payment whose success callback was lost (tab closed in the UPI app switch).
      void syncPendingUpiOrders(userId);
      if (!cancelled) setVerified(true);
    })();

    // Single-device session check every 2 minutes, plus on tab focus.
    const interval = setInterval(() => void checkStillActiveDevice(), 2 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkStillActiveDevice();
        void refreshUnreadNotificationCount(userId);
        void syncPendingUpiOrders(userId);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId]);

  return verified;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const isLoggedIn = useSession((s) => s.isLoggedIn);
  const location = useLocation();
  if (!isLoggedIn) return <Navigate to="/auth" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/** Logged in AND has a city + saved address, otherwise go through onboarding. */
function RequireOnboarded({ children }: { children: ReactNode }) {
  const { isLoggedIn, selectedCity, hasSavedAddress } = useSession();
  if (!isLoggedIn) return <Navigate to="/auth" replace />;
  if (!selectedCity || !hasSavedAddress) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function SessionExpiredRedirect() {
  const message = useSession((s) => s.sessionExpiredMessage);
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (message && location.pathname !== '/auth') {
      toast(message);
      navigate('/auth', { replace: true });
    }
  }, [message, location.pathname, navigate]);
  return null;
}

function ConfigMissing() {
  return (
    <div className="center-fill pad">
      <div className="card pad center">
        <h2>Configuration missing</h2>
        <p className="muted">
          Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> (see <code>.env.example</code>) and
          restart the app.
        </p>
      </div>
    </div>
  );
}

export default function App() {
  useRouteSeo();
  const authReady = useAuthSync();
  const verified = useLoggedInEffects();
  const isLoggedIn = useSession((s) => s.isLoggedIn);
  useEffect(() => {
    if (isLoggedIn) prefetchTabs();
  }, [isLoggedIn]);
  const [maintenance, setMaintenance] = useState<string | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  // Only the very first bootstrap blocks rendering; later logins bootstrap in the background
  // so the login screen is not unmounted mid-flow.
  const [initialDone, setInitialDone] = useState(false);
  useEffect(() => {
    if (authReady && verified) setInitialDone(true);
  }, [authReady, verified]);

  const runStartupChecks = async () => {
    setChecking(true);
    const m = await checkMaintenanceMode().catch(() => ({ enabled: false, message: null }));
    setMaintenance(m.enabled ? m.message ?? 'Service temporarily unavailable. Please try again shortly.' : null);
    setChecking(false);
  };

  useEffect(() => {
    if (isSupabaseConfigured) void runStartupChecks();
  }, []);

  if (!isSupabaseConfigured) return <ConfigMissing />;
  if (maintenance === undefined || !authReady || (isLoggedIn && !verified && !initialDone)) return <CenterSpinner />;
  if (maintenance) return <MaintenancePage message={maintenance} isChecking={checking} onRetry={runStartupChecks} />;

  return (
    <>
      <SessionExpiredRedirect />
      <Suspense fallback={<CenterSpinner />}>
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route
            path="/onboarding"
            element={
              <RequireAuth>
                <LocationOnboardingPage />
              </RequireAuth>
            }
          />
          <Route
            element={
              <RequireOnboarded>
                <TabLayout />
              </RequireOnboarded>
            }
          >
            <Route path="/" element={<HomePage />} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/profile" element={<ProfilePage />} />
          </Route>
          <Route
            element={
              <RequireOnboarded>
                <PlainLayout />
              </RequireOnboarded>
            }
          >
            <Route path="/hotel/:vendorId" element={<HotelMenuPage />} />
            <Route path="/checkout/:type" element={<CheckoutPage />} />
            <Route path="/orders/:orderId" element={<OrderDetailPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/reviews" element={<MyReviewsPage />} />
            <Route path="/addresses" element={<AddressBookPage />} />
            <Route path="/profile/edit" element={<EditProfilePage />} />
            <Route path="/help" element={<HelpSupportPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {isLoggedIn && (
        <>
          <CityPickerModal />
          <LocationDetectDialog />
        </>
      )}
      <ToastHost />
      <IosInstallPrompt loggedIn={isLoggedIn} />
      <AndroidAppPrompt loggedIn={isLoggedIn} />
    </>
  );
}
