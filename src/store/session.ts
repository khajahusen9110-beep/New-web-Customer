import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { City, Profile } from '../lib/types';

// Port of UserSessionManager: user info, selected city and saved-address flags.
// Auth tokens themselves are persisted by supabase-js.

interface SessionState {
  isLoggedIn: boolean;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  userPhone: string | null;
  userRole: string;
  selectedCity: City | null;
  hasSavedAddress: boolean;
  defaultAddressLabel: string | null;
  unreadNotificationCount: number;
  sessionExpiredMessage: string | null;
  deviceId: string;
  ratingPopupShownCount: number;
  ratingPopupDismissedForever: boolean;
  hasRated: boolean;

  saveSession: (p: { userId: string; email?: string | null; name?: string | null; phone?: string | null }) => void;
  updateProfileInfo: (p: Partial<Profile>) => void;
  setSelectedCity: (c: City | null) => void;
  setHasSavedAddress: (has: boolean, label?: string | null) => void;
  setUnreadNotificationCount: (n: number) => void;
  decrementUnread: () => void;
  notifySessionExpired: (msg?: string) => void;
  clearSessionExpiredMessage: () => void;
  logout: () => void;
  recordRatingPopupShown: () => void;
  recordRatingPopupDismissedForever: () => void;
  recordUserRated: () => void;
}

const newDeviceId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const loggedOutFields = {
  isLoggedIn: false,
  userId: null,
  userEmail: null,
  userName: null,
  userPhone: null,
  userRole: 'customer',
  selectedCity: null,
  hasSavedAddress: false,
  defaultAddressLabel: null,
  unreadNotificationCount: 0,
};

export const useSession = create<SessionState>()(
  persist(
    (set, get) => ({
      ...loggedOutFields,
      sessionExpiredMessage: null,
      deviceId: newDeviceId(),
      ratingPopupShownCount: 0,
      ratingPopupDismissedForever: false,
      hasRated: false,

      saveSession: ({ userId, email, name, phone }) =>
        set((s) => ({
          isLoggedIn: true,
          userId,
          userEmail: email ?? s.userEmail,
          userName: name ?? s.userName,
          userPhone: phone ?? s.userPhone,
          sessionExpiredMessage: null,
        })),

      updateProfileInfo: (p) =>
        set((s) => ({
          userName: p.full_name !== undefined ? p.full_name ?? null : s.userName,
          userPhone: p.phone !== undefined ? p.phone ?? null : s.userPhone,
          userRole: p.role ?? s.userRole,
        })),

      setSelectedCity: (c) => set({ selectedCity: c }),

      setHasSavedAddress: (has, label) =>
        set((s) => ({
          hasSavedAddress: has,
          defaultAddressLabel: label !== undefined ? label : s.defaultAddressLabel,
        })),

      setUnreadNotificationCount: (n) => set({ unreadNotificationCount: Math.max(0, n) }),
      decrementUnread: () =>
        set((s) => ({ unreadNotificationCount: Math.max(0, s.unreadNotificationCount - 1) })),

      notifySessionExpired: (msg = 'Your session expired, please log in again') =>
        set({ ...loggedOutFields, sessionExpiredMessage: msg }),
      clearSessionExpiredMessage: () => set({ sessionExpiredMessage: null }),

      logout: () => set({ ...loggedOutFields, sessionExpiredMessage: null }),

      recordRatingPopupShown: () => set({ ratingPopupShownCount: get().ratingPopupShownCount + 1 }),
      recordRatingPopupDismissedForever: () => set({ ratingPopupDismissedForever: true }),
      recordUserRated: () => set({ hasRated: true }),
    }),
    {
      name: 'sndmart-session',
      partialize: (s) => ({
        isLoggedIn: s.isLoggedIn,
        userId: s.userId,
        userEmail: s.userEmail,
        userName: s.userName,
        userPhone: s.userPhone,
        userRole: s.userRole,
        selectedCity: s.selectedCity,
        hasSavedAddress: s.hasSavedAddress,
        defaultAddressLabel: s.defaultAddressLabel,
        deviceId: s.deviceId,
        ratingPopupShownCount: s.ratingPopupShownCount,
        ratingPopupDismissedForever: s.ratingPopupDismissedForever,
        hasRated: s.hasRated,
      }),
    },
  ),
);

export function shouldShowRatingPopup(completedOrderCount: number): boolean {
  const s = useSession.getState();
  if (s.hasRated || s.ratingPopupDismissedForever) return false;
  return (
    completedOrderCount >= 3 && (completedOrderCount - 3) % 5 === 0 && s.ratingPopupShownCount < 3
  );
}
