import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env";

let cached: SupabaseClient | null | undefined;

/**
 * Service-role Supabase client (bypasses RLS). Returns null when the backend is
 * running without Supabase credentials (local dev / preview).
 *
 * Never expose this client's key to a response.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    cached = null;
    return cached;
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Verify a Supabase access token (signature + expiry) and return the user.
 * Uses the admin client's auth endpoint so the JWT secret never has to live here.
 */
export async function verifyAccessToken(
  token: string,
): Promise<{ id: string; email: string | null } | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
