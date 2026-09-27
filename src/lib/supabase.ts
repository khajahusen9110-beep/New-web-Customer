import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

// The client persists the auth session in localStorage and refreshes the
// access token automatically (replaces the Android app's manual token refresh).
export const supabase = createClient(
  url || 'https://invalid.supabase.co',
  anonKey || 'missing-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'sndmart-auth',
    },
  },
);

export const SUPABASE_URL = url || '';
