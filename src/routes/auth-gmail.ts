import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { env } from "../env";
import { supabase } from "../utils/supabase";
import * as crypto from "crypto";
import { getCallbackPageHTML } from "./auth-gmail-callback-page";

const router = new Hono();

/**
 * Gmail OAuth Configuration
 */
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SCOPES = ["gmail.readonly", "gmail.modify"];

/**
 * POST /api/auth/gmail/login
 * Initiates the Gmail OAuth flow
 * Returns the Google authorization URL
 */
router.post("/login", async (c) => {
  try {
    if (!env.GOOGLE_CLIENT_ID) {
      return c.json({ error: "Google OAuth not configured" }, 400);
    }

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString("hex");
    
    // Store state in a short-lived cache (in production, use Redis)
    // For now, we'll pass it back and validate on callback
    
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${env.BACKEND_URL}/api/auth/gmail/callback`,
      response_type: "code",
      scope: GMAIL_SCOPES.join(" "),
      access_type: "offline", // Get refresh token
      prompt: "consent", // Force consent screen every time
      state: state,
    });

    const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

    return c.json({
      authUrl,
      state, // Return state so frontend can verify
    });
  } catch (error) {
    console.error("Gmail login error:", error);
    return c.json({ error: "Failed to initiate Gmail login" }, 500);
  }
});

/**
 * GET /api/auth/gmail/callback
 * Handles the OAuth redirect from Google
 * Exchanges authorization code for access token
 */
router.get("/callback", async (c) => {
  try {
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code) {
      return c.json(
        { error: "Missing authorization code" },
        400
      );
    }

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return c.json({ error: "Google OAuth not configured" }, 500);
    }

    // Exchange authorization code for tokens
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code: code,
        grant_type: "authorization_code",
        redirect_uri: `${env.BACKEND_URL}/api/auth/gmail/callback`,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error("Token exchange failed:", error);
      return c.json({ error: "Failed to exchange authorization code" }, 400);
    }

    const tokens = await tokenResponse.json();
    
    // Decode JWT to get user info (Gmail email)
    const userInfo = decodeJWT(tokens.id_token);
    const email = userInfo.email;

    // TODO: Store encrypted token in Supabase
    // For now, inject it into the callback page HTML
    const callbackHTML = getCallbackPageHTML(env.BACKEND_URL);
    const htmlWithToken = callbackHTML.replace(
      'const tokenData = window.__GMAIL_TOKEN_DATA__;',
      `const tokenData = ${JSON.stringify({
        email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
      })};`
    );

    c.header('Content-Type', 'text/html; charset=utf-8');
    return c.html(htmlWithToken);
  } catch (error) {
    console.error("Gmail callback error:", error);
    return c.json({ error: "Failed to process callback" }, 500);
  }
});

/**
 * POST /api/auth/gmail/revoke
 * Revokes Gmail access token
 */
router.post("/revoke", async (c) => {
  try {
    const { accessToken } = await c.req.json();

    if (!accessToken) {
      return c.json({ error: "Missing access token" }, 400);
    }

    // Revoke token with Google
    const response = await fetch(
      `https://oauth2.googleapis.com/revoke?token=${accessToken}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (response.ok) {
      return c.json({ success: true });
    } else {
      return c.json({ error: "Failed to revoke token" }, 400);
    }
  } catch (error) {
    console.error("Gmail revoke error:", error);
    return c.json({ error: "Failed to revoke token" }, 500);
  }
});

/**
 * Utility: Decode JWT without verification (safe for ID token info)
 * Note: In production, verify the signature
 */
function decodeJWT(token: string): any {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");

  const payload = parts[1];
  const decoded = Buffer.from(payload, "base64").toString("utf-8");
  return JSON.parse(decoded);
}

export { router as authGmailRouter };
