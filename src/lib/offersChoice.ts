import { supabase } from './supabase';

/**
 * "Get offers and order updates on WhatsApp" choice. Ticked by default for a customer who has not chosen
 * yet; the customer can untick it at checkout or in My Account. Saved on the server (same list the WhatsApp
 * bot's Yes / STOP uses). Order messages are never affected by it.
 */
export interface OffersChoice { checked: boolean; decided: boolean; usable: boolean }

export async function fetchOffersChoice(): Promise<OffersChoice> {
  try {
    const { data, error } = await supabase.rpc('wa_get_my_offers_choice');
    if (error || !data) return { checked: true, decided: false, usable: true };
    const d = data as { checked?: boolean; decided?: boolean; usable?: boolean };
    return { checked: d.checked !== false, decided: !!d.decided, usable: d.usable !== false };
  } catch {
    return { checked: true, decided: false, usable: true };
  }
}

export async function saveOffersChoice(on: boolean, source: string): Promise<void> {
  try {
    await supabase.rpc('wa_set_my_offers_choice', { p_on: on, p_source: source });
  } catch {
    /* the choice is saved again the next time it is changed */
  }
}
