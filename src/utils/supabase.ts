import { createClient } from "@supabase/supabase-js";
import { env } from "../env";

/**
 * Supabase Client
 * Uses SERVICE_ROLE_KEY for server-side operations with elevated privileges
 */
export const supabase = createClient(
  env.SUPABASE_URL || "",
  env.SUPABASE_SERVICE_ROLE_KEY || ""
);

/**
 * Store Gmail tokens securely in Supabase
 */
export async function storeGmailToken(
  userId: string,
  email: string,
  accessToken: string,
  refreshToken: string | null,
  expiresIn: number
) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  const { data, error } = await supabase
    .from("gmail_tokens")
    .upsert(
      {
        user_id: userId,
        email,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "user_id",
      }
    )
    .select();

  if (error) {
    throw new Error(`Failed to store Gmail token: ${error.message}`);
  }

  return data;
}

/**
 * Retrieve Gmail token for a user
 */
export async function getGmailToken(userId: string) {
  const { data, error } = await supabase
    .from("gmail_tokens")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error) {
    return null;
  }

  return data;
}

/**
 * Revoke Gmail token (delete from database)
 */
export async function revokeGmailToken(userId: string) {
  const { error } = await supabase
    .from("gmail_tokens")
    .delete()
    .eq("user_id", userId);

  if (error) {
    throw new Error(`Failed to revoke Gmail token: ${error.message}`);
  }
}

/**
 * Refresh Gmail access token if expired
 */
export async function refreshGmailToken(userId: string) {
  const token = await getGmailToken(userId);

  if (!token || !token.refresh_token) {
    throw new Error("No refresh token available");
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  const newTokens = await response.json();

  // Update token in database
  await storeGmailToken(
    userId,
    token.email,
    newTokens.access_token,
    token.refresh_token, // Keep existing refresh token
    newTokens.expires_in
  );

  return newTokens.access_token;
}
