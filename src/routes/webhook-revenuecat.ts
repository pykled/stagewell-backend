/**
 * RevenueCat Webhook Handler
 *
 * Endpoint: POST /api/webhooks/revenuecat
 *
 * Receives server-side subscription lifecycle events from RevenueCat and keeps
 * the Supabase database in sync — independent of client-side RC SDK calls.
 *
 * Events handled:
 *   INITIAL_PURCHASE  → set paid tier, grant credits for the new period
 *   RENEWAL           → refresh tier, reset credits (idempotent)
 *   CANCELLATION      → mark will_renew=false; access preserved until expiration
 *   EXPIRATION        → downgrade profile to free tier
 *   BILLING_ISSUE     → mark will_renew=false; access preserved during grace period
 *
 * Idempotency:
 *   The event.id from RC is written to webhook_events BEFORE any state mutation.
 *   A UNIQUE constraint on event_id means duplicate deliveries hit a conflict and
 *   are rejected before touching profiles or credit_ledger.
 *
 * Credit grants use the same idempotency keys as client-side resets
 * (e.g. "monthly_reset:2026-03:professional") so whichever path runs first
 * "wins" and the other is silently dropped by the DB-level unique index.
 *
 * Authorization:
 *   RC sends the configured secret in the Authorization header (raw value, no
 *   "Bearer" prefix). The handler returns 401 for any mismatch.
 */

import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";
import { env } from "../env";

// ─── Types ────────────────────────────────────────────────────────────────────

/** RC event types we act on. All others are acknowledged and ignored. */
const ACTIVE_EVENTS    = new Set(["INITIAL_PURCHASE", "RENEWAL", "PRODUCT_CHANGE"]);
const INACTIVE_EVENTS  = new Set(["EXPIRATION"]);
const RENEW_OFF_EVENTS = new Set(["CANCELLATION", "BILLING_ISSUE"]);
const RENEW_ON_EVENTS  = new Set(["UNCANCELLATION"]);
const ALL_HANDLED = new Set([...ACTIVE_EVENTS, ...INACTIVE_EVENTS, ...RENEW_OFF_EVENTS, ...RENEW_ON_EVENTS]);

/**
 * Tier rank used to detect effective downgrades.
 * Higher number = more premium. A RENEWAL/PRODUCT_CHANGE is a downgrade when
 * the new tier rank is strictly less than the previously active tier rank.
 */
const TIER_RANK: Record<string, number> = {
  free:         0,
  professional: 1,
  scale:        2,
  unlimited:    3,
};

/**
 * Monthly credit cap per tier.
 * null = unlimited tier (daily-reset model — no static monthly cap to clamp to).
 * These must mirror the TIER_CREDITS constants in the mobile subscription store.
 */
const TIER_CAP: Record<string, number | null> = {
  free:         3,
  professional: 20,
  scale:        50,
  unlimited:    null,
};

/** A minimal typed view of the RevenueCat event object. */
interface RCEvent {
  id: string;
  type: string;
  app_user_id: string;
  original_app_user_id?: string;
  product_id?: string;
  entitlement_ids?: string[];
  expiration_at_ms?: number | null;
  grace_period_expiration_at_ms?: number | null;
  environment: "PRODUCTION" | "SANDBOX";
  store?: string;
  period_type?: string;
  purchased_at_ms?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a subscription tier from a RevenueCat product identifier.
 * Mirrors the getTierFromProductId() logic in revenuecatClient.ts.
 */
function tierFromProductId(productId: string): "professional" | "scale" | "unlimited" {
  const lower = productId.toLowerCase();
  if (lower.includes("unlimited"))    return "unlimited";
  if (lower.includes("scale"))        return "scale";
  if (lower.includes("professional")) return "professional";
  // Fallback: any product that grants the "premium" entitlement is at least professional
  return "professional";
}

/**
 * Build a Supabase client that uses the service-role key, which bypasses RLS.
 * Returns null if credentials are not configured (dev/preview without Supabase).
 */
function buildSupabaseAdmin() {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const revenuecatWebhookRouter = new Hono();

// Temporary GET handler for deployment verification
revenuecatWebhookRouter.get("/", (c) => {
  return c.text("RevenueCat webhook route is live");
});

revenuecatWebhookRouter.post("/", async (c) => {
  // ── 1. Verify webhook secret ──────────────────────────────────────────────
  const expectedSecret = env.REVENUECAT_WEBHOOK_SECRET;
  if (expectedSecret) {
    const incoming = c.req.header("Authorization");
    if (!incoming || incoming !== expectedSecret) {
      console.warn("[RC Webhook] Rejected: invalid Authorization header");
      return c.json({ error: "Unauthorized" }, 401);
    }
  } else {
    console.warn("[RC Webhook] REVENUECAT_WEBHOOK_SECRET not set — skipping auth check");
  }

  // ── 2. Parse and validate payload ─────────────────────────────────────────
  let body: { event?: RCEvent; api_version?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const event = body?.event;
  if (!event?.id || !event?.type || !event?.app_user_id) {
    return c.json({ error: "Missing required event fields (id, type, app_user_id)" }, 400);
  }

  const { id: eventId, type: eventType, app_user_id, product_id, environment: rcEnv } = event;

  // Acknowledge but ignore event types we don't handle
  if (!ALL_HANDLED.has(eventType)) {
    console.log(`[RC Webhook] Skipping unhandled event type: ${eventType} (id=${eventId})`);
    return c.json({ ok: true, skipped: true });
  }

  // ── 3. Build DB client ────────────────────────────────────────────────────
  const supabase = buildSupabaseAdmin();
  if (!supabase) {
    console.error("[RC Webhook] Supabase credentials not configured — cannot process event");
    // Return 200 so RC doesn't retry indefinitely in preview/dev environments
    return c.json({ ok: false, reason: "supabase_not_configured" });
  }

  // ── 4. Idempotency — insert event_id before mutating any state ────────────
  //    On conflict (duplicate delivery) → return 200 immediately.
  //
  //    user_id is stored as null when app_user_id is not a valid UUID (e.g.
  //    RevenueCat anonymous IDs like "30") to avoid a PostgreSQL type error
  //    (22P02 "invalid input syntax for type uuid") that would otherwise make
  //    every such delivery return HTTP 500 before the UUID guard below fires.
  //    The column is nullable and the UUID guard at step 5 still handles the
  //    early-return for non-UUID app_user_ids.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  console.log(`[RC Webhook] STEP4 inserting webhook_event event_id=${eventId} type=${eventType} app_user_id=${app_user_id} uuid_valid=${uuidRe.test(app_user_id)}`);

  const { error: insertErr } = await supabase.from("webhook_events").insert({
    event_id:    eventId,
    event_type:  eventType,
    user_id:     uuidRe.test(app_user_id) ? app_user_id : null,
    product_id:  product_id ?? null,
    environment: rcEnv,
    payload:     event as unknown as Record<string, unknown>,
  });

  if (insertErr) {
    console.error(`[RC Webhook] STEP4 insert error code=${insertErr.code} msg=${insertErr.message} details=${insertErr.details} hint=${insertErr.hint}`);
    if (insertErr.code === "23505") {
      // Unique violation = event already seen. Check if the prior attempt errored —
      // if it did, clear the error flag and fall through to re-process.
      // If it succeeded, return 200 immediately (true duplicate).
      const { data: prior } = await supabase
        .from("webhook_events")
        .select("error")
        .eq("event_id", eventId)
        .single();

      if (prior?.error) {
        console.log(`[RC Webhook] Re-processing previously failed event ${eventId} (prior error: ${prior.error})`);
        await supabase
          .from("webhook_events")
          .update({ error: null, processed_at: new Date().toISOString() })
          .eq("event_id", eventId);
        // Fall through to processing below
      } else {
        console.log(`[RC Webhook] Duplicate delivery for event ${eventId} — skipping`);
        return c.json({ ok: true, duplicate: true });
      }
    } else {
      // Unexpected DB error — surface it so RC retries
      console.error("[RC Webhook] Failed to insert webhook_events row:", insertErr.message);
      return c.json({ error: "Database error" }, 500);
    }
  }

  // ── 5. Resolve user ───────────────────────────────────────────────────────
  // app_user_id is set to the Supabase user ID via Purchases.logIn(supabaseUserId).
  // Validate it looks like a UUID before touching the DB.
  if (!uuidRe.test(app_user_id)) {
    const msg = `app_user_id is not a valid UUID: ${app_user_id}`;
    console.error(`[RC Webhook] ${msg}`);
    await supabase
      .from("webhook_events")
      .update({ error: msg })
      .eq("event_id", eventId);
    return c.json({ ok: false, reason: "invalid_user_id" });
  }

  const userId = app_user_id;

  // ── 6. Process event ──────────────────────────────────────────────────────
  try {
    console.log(`[RC Webhook] STEP6_BEGIN event=${eventId} type=${eventType} app_user_id=${app_user_id} user=${userId}`);

    // ── A) INITIAL_PURCHASE / RENEWAL / PRODUCT_CHANGE — activate or refresh ──
    if (ACTIVE_EVENTS.has(eventType)) {
      const tier = tierFromProductId(product_id ?? "");
      const expiresAt = event.expiration_at_ms
        ? new Date(event.expiration_at_ms).toISOString()
        : null;

      // Read the currently active tier BEFORE overwriting it.
      // Required to detect effective tier downgrades (e.g. Scale → Professional
      // on renewal).  Only RENEWAL and PRODUCT_CHANGE can be downgrades;
      // INITIAL_PURCHASE always starts from free so rank comparison is still safe.
      console.log(`[RC Webhook] STEP6A_READ_PROFILE event=${eventId} user=${userId}`);
      const { data: currentProfile, error: profileReadErr } = await supabase
        .from("profiles")
        .select("plan")
        .eq("user_id", userId)
        .single();
      if (profileReadErr && profileReadErr.code !== "PGRST116") {
        // PGRST116 = "no rows" which is expected for new users; anything else is a real error
        console.error(`[RC Webhook] STEP6A_READ_PROFILE WARN code=${profileReadErr.code} msg=${profileReadErr.message} details=${profileReadErr.details} hint=${profileReadErr.hint}`);
      } else {
        console.log(`[RC Webhook] STEP6A_READ_PROFILE OK prev_plan=${currentProfile?.plan ?? "(no row)"}`);
      }
      const prevTier = (currentProfile?.plan ?? "free") as string;

      // Update subscription metadata on the profile
      console.log(`[RC Webhook] STEP6A_UPDATE_PROFILE event=${eventId} user=${userId} tier=${tier} expires_at=${expiresAt}`);
      const { error: profileErr } = await supabase
        .from("profiles")
        .update({
          plan:                     tier,
          subscription_product_id:  product_id ?? null,
          subscription_expires_at:  expiresAt,
          subscription_will_renew:  true,
          subscription_updated_at:  new Date().toISOString(),
        })
        .eq("user_id", userId);

      if (profileErr) {
        console.error(`[RC Webhook] STEP6A_UPDATE_PROFILE FAILED code=${profileErr.code} msg=${profileErr.message} details=${profileErr.details} hint=${profileErr.hint}`);
        throw new Error(`profiles update failed: code=${profileErr.code} msg=${profileErr.message} details=${profileErr.details}`);
      }
      console.log(`[RC Webhook] STEP6A_UPDATE_PROFILE OK`);

      // Grant credits for this period (idempotent via server_grant_subscription_credits).
      // Uses the same request_id keys as the client so whichever side runs first wins.
      //
      // Requires: idx_credit_ledger_meta_request_id (migration 20260321_credit_consume_idempotency).
      // If that index is missing the RPC fails with Postgres error 42P10.
      console.log(`[RC Webhook] STEP6A_GRANT_CREDITS event=${eventId} user=${userId} plan=${tier}`);
      const { data: grantData, error: grantErr } = await supabase.rpc(
        "server_grant_subscription_credits",
        { p_user_id: userId, p_plan: tier, p_event_id: eventId },
      );

      if (grantErr) {
        console.error(`[RC Webhook] STEP6A_GRANT_CREDITS FAILED code=${grantErr.code} msg=${grantErr.message} details=${grantErr.details} hint=${grantErr.hint}`);
        if (grantErr.code === "42P10") {
          console.error("[RC Webhook] STEP6A_GRANT_CREDITS: missing unique index idx_credit_ledger_meta_request_id — run migration 20260321_credit_consume_idempotency.sql in Supabase SQL Editor");
        }
        throw new Error(`credit grant failed: code=${grantErr.code} msg=${grantErr.message} details=${grantErr.details}`);
      }
      console.log(`[RC Webhook] STEP6A_GRANT_CREDITS OK result=${JSON.stringify(grantData)}`);

      // ── Effective downgrade clamp ────────────────────────────────────────
      // If the new tier is lower than the previously active tier this event
      // represents an effective (not merely scheduled) tier reduction.
      // Examples: Scale→Professional on RENEWAL, Scale→Professional on
      // PRODUCT_CHANGE when Apple activates the deferred switch.
      //
      // We must NOT rely on CANCELLATION for this — cancellation only marks
      // will_renew=false and does not change the active plan.  Clamping here
      // (on the event where the lower tier first becomes active) is Apple-
      // compliant: the user retains full credits until the moment they lose
      // the higher tier.
      const newRank  = TIER_RANK[tier]     ?? 0;
      const prevRank = TIER_RANK[prevTier] ?? 0;

      if (newRank < prevRank) {
        const cap = TIER_CAP[tier];
        if (cap !== null) {
          // clamp_credits_to_cap is idempotent via (user_id, request_id).
          // Using eventId ensures RC retries never apply the clamp twice.
          console.log(`[RC Webhook] STEP6A_DOWNGRADE_CLAMP event=${eventId} user=${userId} prevTier=${prevTier} newTier=${tier} cap=${cap}`);
          const { error: clampErr } = await supabase.rpc("clamp_credits_to_cap", {
            p_user_id:    userId,
            p_cap:        cap,
            p_request_id: `downgrade_clamp:${eventId}`,
          });

          if (clampErr) {
            console.error(`[RC Webhook] STEP6A_DOWNGRADE_CLAMP FAILED code=${clampErr.code} msg=${clampErr.message} details=${clampErr.details} hint=${clampErr.hint}`);
            if (clampErr.code === "42P10") {
              console.error("[RC Webhook] STEP6A_DOWNGRADE_CLAMP: missing unique index idx_credit_ledger_meta_request_id — run migration 20260321_credit_consume_idempotency.sql");
            }
            throw new Error(`credit clamp failed: code=${clampErr.code} msg=${clampErr.message} details=${clampErr.details}`);
          }
          console.log(`[RC Webhook] STEP6A_DOWNGRADE_CLAMP OK ${prevTier}→${tier} clamped_to=${cap}`);
        }
      }
    }

    // ── B) CANCELLATION / BILLING_ISSUE — access preserved, no renewal ────
    else if (RENEW_OFF_EVENTS.has(eventType)) {
      // Keep the current plan — the user still has access until expiration.
      // Only mark that the subscription will not renew.
      console.log(`[RC Webhook] STEP6B_UPDATE_PROFILE event=${eventId} user=${userId} will_renew=false`);
      const { error: profileErr } = await supabase
        .from("profiles")
        .update({
          subscription_will_renew: false,
          subscription_updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);

      if (profileErr) {
        console.error(`[RC Webhook] STEP6B_UPDATE_PROFILE FAILED code=${profileErr.code} msg=${profileErr.message} details=${profileErr.details} hint=${profileErr.hint}`);
        throw new Error(`profiles update failed: code=${profileErr.code} msg=${profileErr.message} details=${profileErr.details}`);
      }
      console.log(`[RC Webhook] STEP6B_UPDATE_PROFILE OK → will_renew=false for user ${userId}`);
    }

    // ── C) UNCANCELLATION — user re-enabled auto-renew before expiry ──────
    else if (RENEW_ON_EVENTS.has(eventType)) {
      console.log(`[RC Webhook] STEP6C_UPDATE_PROFILE event=${eventId} user=${userId} will_renew=true`);
      const { error: profileErr } = await supabase
        .from("profiles")
        .update({
          subscription_will_renew: true,
          subscription_updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);

      if (profileErr) {
        console.error(`[RC Webhook] STEP6C_UPDATE_PROFILE FAILED code=${profileErr.code} msg=${profileErr.message} details=${profileErr.details} hint=${profileErr.hint}`);
        throw new Error(`profiles update failed: code=${profileErr.code} msg=${profileErr.message} details=${profileErr.details}`);
      }
      console.log(`[RC Webhook] STEP6C_UPDATE_PROFILE OK → will_renew=true for user ${userId}`);
    }

    // ── E) EXPIRATION — subscription ended, downgrade to free ────────────
    // This fires when a paid subscription fully expires (cancelled and the
    // billing period ended, or billing failed after the grace period).
    // The user has had no active paid tier since the period ended, so
    // clamping to the free cap (3) is correct and Apple-compliant.
    // Mid-tier downgrades (e.g. Scale→Professional) are handled above in
    // the RENEWAL/PRODUCT_CHANGE path, not here.
    else if (INACTIVE_EVENTS.has(eventType)) {
      console.log(`[RC Webhook] STEP6D_UPDATE_PROFILE event=${eventId} user=${userId} downgrade_to=free`);
      const { error: profileErr } = await supabase
        .from("profiles")
        .update({
          plan:                    "free",
          subscription_product_id: null,
          subscription_expires_at: null,
          subscription_will_renew: false,
          subscription_updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);

      if (profileErr) {
        console.error(`[RC Webhook] STEP6D_UPDATE_PROFILE FAILED code=${profileErr.code} msg=${profileErr.message} details=${profileErr.details} hint=${profileErr.hint}`);
        throw new Error(`profiles update failed: code=${profileErr.code} msg=${profileErr.message} details=${profileErr.details}`);
      }
      console.log(`[RC Webhook] STEP6D_UPDATE_PROFILE OK`);

      // Clamp credits to free-tier cap (3).  Uses event_id as the idempotency
      // key so RC retries can never apply the clamp twice for the same event.
      //
      // Requires: idx_credit_ledger_meta_request_id (migration 20260321_credit_consume_idempotency).
      // If that index is missing the RPC fails with Postgres error 42P10.
      console.log(`[RC Webhook] STEP6D_CLAMP_FREE_TIER event=${eventId} user=${userId}`);
      const { error: clampErr } = await supabase.rpc("clamp_credits_to_free_tier", {
        p_user_id:    userId,
        p_request_id: `downgrade_clamp:${eventId}`,
      });

      if (clampErr) {
        console.error(`[RC Webhook] STEP6D_CLAMP_FREE_TIER FAILED code=${clampErr.code} msg=${clampErr.message} details=${clampErr.details} hint=${clampErr.hint}`);
        if (clampErr.code === "42P10") {
          console.error("[RC Webhook] STEP6D_CLAMP_FREE_TIER: missing unique index idx_credit_ledger_meta_request_id — run migration 20260321_credit_consume_idempotency.sql");
        }
        throw new Error(`credit clamp failed: code=${clampErr.code} msg=${clampErr.message} details=${clampErr.details}`);
      }
      console.log(`[RC Webhook] STEP6D_CLAMP_FREE_TIER OK user=${userId} clamped_to_free`);
    }

    console.log(`[RC Webhook] STEP6_DONE event=${eventId} type=${eventType} user=${userId}`);
    return c.json({ ok: true });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[RC Webhook] STEP6_ERROR event=${eventId} type=${eventType} user=${userId} error=${message}`);

    // Record the error on the webhook_events row for post-mortem debugging
    await supabase
      .from("webhook_events")
      .update({ error: message })
      .eq("event_id", eventId);

    // Return 500 so RevenueCat retries the delivery
    return c.json({ error: "Processing failed" }, 500);
  }
});
