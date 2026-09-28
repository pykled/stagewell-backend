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
 *
 * Returns null on auth rejection (invalid/expired token).
 * Throws on Supabase service errors so the caller can return 503 rather than
 * 401 — a transient backend error should not look like an auth failure to the app.
 */
export async function verifyAccessToken(
  token: string,
): Promise<{ id: string; email: string | null } | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error) {
    // 4xx auth errors (invalid/expired token) → return null so caller sends 401.
    // 5xx / network errors → throw so caller sends 503, not a misleading 401.
    const status = (error as { status?: number }).status;
    console.error(`[Auth] token verification failed: status=${status} name=${error.name} msg=${error.message}`);
    if (status !== undefined && status >= 500) {
      throw new Error(`Supabase auth service error (${status}): ${error.message}`);
    }
    return null;
  }
  if (!data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
