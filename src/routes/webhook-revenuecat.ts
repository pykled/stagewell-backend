/**
 * RevenueCat Webhook Handler
 *
 * Endpoint: POST /api/webhooks/revenuecat
 *
 * Receives server-side subscription lifecycle events from RevenueCat and keeps
 * the Supabase database in sync — independent of client-side RC SDK calls.
 * The webhook is the source of truth for subscription_* columns; the app's own
 * plan writes never carry an expiry, so a webhook event always wins over them.
 *
 * Events handled:
 *   INITIAL_PURCHASE / RENEWAL   → set paid tier + expiry, grant credits for the period (idempotent)
 *   PRODUCT_CHANGE               → applied only when new_product_id is an upgrade (Apple upgrades are
 *                                  immediate); downgrades take effect on the RENEWAL that carries them
 *   CANCELLATION / BILLING_ISSUE → will_renew=false; access preserved until expiration
 *   UNCANCELLATION               → will_renew=true
 *   EXPIRATION                   → downgrade to free + clamp credits, unless a later period is recorded;
 *                                  subscription_expires_at keeps the ended period for ordering checks
 *   NON_RENEWING_PURCHASE        → credit pack via grant_credit_pack (amount from PACK_CREDITS)
 * Everything else (TEST, TRANSFER, SUBSCRIPTION_EXTENDED, …) is acknowledged with 200 and ignored.
 *
 * Idempotency:
 *   The event.id from RC is written to webhook_events BEFORE any state mutation.
 *   A UNIQUE constraint on event_id means duplicate deliveries hit a conflict and
 *   are rejected before touching profiles or credit_ledger. Every RPC below is
 *   itself idempotent, so re-processing a previously failed event is safe.
 *
 * Environment:
 *   SANDBOX events are recorded in webhook_events but do not touch profiles or
 *   credits unless REVENUECAT_PROCESS_SANDBOX=true (TestFlight purchases are free).
 *
 * User resolution:
 *   app_user_id, original_app_user_id and aliases are searched for a Supabase
 *   user UUID; failing that, subscription_claims maps an $RCAnonymousID to a user.
 *
 * Authorization:
 *   RC sends the configured value in the Authorization header. Both the raw
 *   secret and "Bearer <secret>" are accepted; comparison is constant-time.
 */

import { Hono } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env";
import { getSupabaseAdmin } from "../lib/supabase-admin";

// ─── Types ────────────────────────────────────────────────────────────────────

/** RC event types we act on. All others are acknowledged and ignored. */
const ACTIVE_EVENTS    = new Set(["INITIAL_PURCHASE", "RENEWAL"]);
const CHANGE_EVENTS    = new Set(["PRODUCT_CHANGE"]);
const INACTIVE_EVENTS  = new Set(["EXPIRATION"]);
const RENEW_OFF_EVENTS = new Set(["CANCELLATION", "BILLING_ISSUE"]);
const RENEW_ON_EVENTS  = new Set(["UNCANCELLATION"]);
const PACK_EVENTS      = new Set(["NON_RENEWING_PURCHASE"]);
const ALL_HANDLED = new Set([
  ...ACTIVE_EVENTS, ...CHANGE_EVENTS, ...INACTIVE_EVENTS, ...RENEW_OFF_EVENTS, ...RENEW_ON_EVENTS, ...PACK_EVENTS,
]);

type Tier = "professional" | "scale" | "unlimited";

/**
 * Tier rank used to detect effective downgrades.
 * Higher number = more premium. A RENEWAL is a downgrade when the new tier
 * rank is strictly less than the previously active tier rank.
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

/** Subscription product ids (App Store Connect / RC offering stagewell_v2). */
const PRODUCT_TIER: Record<string, Tier> = {
  professional_monthly_19: "professional",
  scale_monthly_39:        "scale",
  unlimited_monthly_99:    "unlimited",
};

/**
 * Consumable credit packs (ASC: credits_10 $15, credits_25 $30, credits_50 $50;
 * credits_pack_20 is the id named in 20260915_pricing_v2_grants.sql).
 * Amounts are the product definitions — do not change them here.
 */
const PACK_CREDITS: Record<string, number> = {
  credits_10:      10,
  credits_25:      25,
  credits_50:      50,
  credits_pack_20: 20,
};

/** A minimal typed view of the RevenueCat event object. */
export interface RCEvent {
  id: string;
  type: string;
  app_user_id?: string | null;
  original_app_user_id?: string | null;
  aliases?: string[] | null;
  product_id?: string | null;
  new_product_id?: string | null;
  entitlement_ids?: string[] | null;
  expiration_at_ms?: number | null;
  grace_period_expiration_at_ms?: number | null;
  event_timestamp_ms?: number | null;
  environment?: "PRODUCTION" | "SANDBOX";
  store?: string;
  period_type?: string;
  purchased_at_ms?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive a subscription tier from a RevenueCat product identifier.
 * Explicit table first; substring match kept for renamed SKUs of the same tier.
 * Returns null for an unknown product so it can never silently become professional.
 */
export function tierFromProductId(productId: string | null | undefined): Tier | null {
  if (!productId) return null;
  const lower = productId.toLowerCase();
  if (PRODUCT_TIER[lower]) return PRODUCT_TIER[lower];
  if (lower.includes("unlimited"))    return "unlimited";
  if (lower.includes("scale"))        return "scale";
  if (lower.includes("professional")) return "professional";
  return null;
}

export function packCreditsFromProductId(productId: string | null | undefined): number | null {
  if (!productId) return null;
  return PACK_CREDITS[productId.toLowerCase()] ?? null;
}

/** Constant-time compare of the Authorization header against the secret (raw or Bearer form). */
export function authorized(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const want = digest(secret);
  const raw = header.trim();
  const bearer = raw.replace(/^Bearer\s+/i, "");
  // Evaluate both so timing does not reveal which form matched.
  const a = timingSafeEqual(digest(raw), want);
  const b = timingSafeEqual(digest(bearer), want);
  return a || b;
}

/** One JSON line per step. User ids are truncated; no emails or payloads are logged. */
function log(level: "info" | "warn" | "error", step: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ evt: "rc_webhook", step, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const short = (id: string | null | undefined) =>
  id ? (UUID_RE.test(id) ? id.slice(0, 8) : id.slice(0, 40).replace(/[0-9a-f]{12,}$/i, "…")) : null;

type Resolved = { userId: string; via: string } | { userId: null; reason: string };

/**
 * Find the Supabase user for an event.
 *   1. UUID candidates in app_user_id → original_app_user_id → aliases order; the first one with a
 *      profiles row wins (falls back to the first UUID if none has a row yet).
 *   2. Otherwise subscription_claims maps an RC id (e.g. $RCAnonymousID:…) to exactly one user.
 */
async function resolveUser(supabase: SupabaseClient, event: RCEvent): Promise<Resolved> {
  const candidates = [event.app_user_id, event.original_app_user_id, ...(Array.isArray(event.aliases) ? event.aliases : [])]
    .filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200);
  const unique = [...new Set(candidates)];
  const uuids = [...new Set(unique.filter((x) => UUID_RE.test(x)).map((x) => x.toLowerCase()))];

  const first = uuids[0];
  if (first !== undefined) {
    if (uuids.length === 1) return { userId: first, via: "uuid" };
    const { data, error } = await supabase.from("profiles").select("user_id").in("user_id", uuids);
    if (error) throw new Error(`profiles lookup failed: code=${error.code} msg=${error.message}`);
    const have = new Set((data ?? []).map((r: { user_id: string }) => String(r.user_id).toLowerCase()));
    const hit = uuids.find((u) => have.has(u));
    return { userId: hit ?? first, via: hit ? "uuid_profile" : "uuid" };
  }

  const others = unique.slice(0, 50);
  if (others.length === 0) return { userId: null, reason: "no_user_id" };
  const { data, error } = await supabase
    .from("subscription_claims")
    .select("supabase_user_id")
    .in("rc_app_user_id", others);
  if (error) throw new Error(`subscription_claims lookup failed: code=${error.code} msg=${error.message}`);
  const owners = [...new Set((data ?? []).map((r: { supabase_user_id: string }) => String(r.supabase_user_id).toLowerCase()))];
  const owner = owners[0];
  if (owners.length === 1 && owner !== undefined && UUID_RE.test(owner)) return { userId: owner, via: "claim" };
  if (owners.length > 1) return { userId: null, reason: "ambiguous_claim" };
  return { userId: null, reason: "anonymous_unclaimed" };
}

const isoOrNull = (ms: number | null | undefined) =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
const msOrNull = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const finiteMs = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? ms : null);

function fail(step: string, err: { code?: string; message?: string; details?: string | null }) {
  if (err.code === "42P10") {
    log("error", step, { hint: "missing unique index idx_credit_ledger_meta_request_id — run migration 20260321_credit_consume_idempotency.sql" });
  }
  return new Error(`${step} failed: code=${err.code} msg=${err.message} details=${err.details ?? ""}`);
}

// ─── Router ───────────────────────────────────────────────────────────────────

export interface RevenuecatWebhookDeps {
  getSupabase: () => SupabaseClient | null;
  getSecret: () => string | undefined;
  processSandbox: () => boolean;
  isProduction: () => boolean;
}

const defaultDeps: RevenuecatWebhookDeps = {
  getSupabase: getSupabaseAdmin,
  getSecret: () => env.REVENUECAT_WEBHOOK_SECRET,
  processSandbox: () => /^(1|true|yes)$/i.test(process.env.REVENUECAT_PROCESS_SANDBOX ?? ""),
  isProduction: () => env.NODE_ENV === "production",
};

export function createRevenuecatWebhookRouter(deps: RevenuecatWebhookDeps = defaultDeps) {
  const router = new Hono();

  // GET kept for deployment verification
  router.get("/", (c) => c.text("RevenueCat webhook route is live"));

  router.post("/", async (c) => {
    // ── 1. Verify webhook secret ────────────────────────────────────────────
    const expectedSecret = deps.getSecret();
    if (expectedSecret) {
      if (!authorized(c.req.header("Authorization"), expectedSecret)) {
        log("warn", "auth_rejected", { has_header: Boolean(c.req.header("Authorization")) });
        return c.json({ error: "Unauthorized" }, 401);
      }
    } else if (deps.isProduction()) {
      log("error", "auth_unconfigured");
      return c.json({ error: "Webhook secret not configured" }, 503);
    } else {
      log("warn", "auth_skipped_dev");
    }

    // ── 2. Parse and validate payload ───────────────────────────────────────
    let body: { event?: RCEvent; api_version?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const event = body?.event;
    if (!event || typeof event !== "object" || typeof event.id !== "string" || !event.id
        || event.id.length > 200 || typeof event.type !== "string" || !event.type) {
      return c.json({ error: "Missing required event fields (id, type)" }, 400);
    }

    const { id: eventId, type: eventType } = event;
    const rcEnv = event.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION";
    const base = { event_id: eventId, type: eventType.slice(0, 40), env: rcEnv };

    // Acknowledge but ignore event types we don't handle (TEST, TRANSFER, …)
    if (!ALL_HANDLED.has(eventType)) {
      log("info", "skipped_unhandled", base);
      return c.json({ ok: true, skipped: true });
    }

    // ── 3. Build DB client ──────────────────────────────────────────────────
    const supabase = deps.getSupabase();
    if (!supabase) {
      log("error", "supabase_unconfigured", base);
      return c.json({ error: "Supabase not configured" }, 503);
    }

    // ── 4. Idempotency — insert event_id before mutating any state ──────────
    //    user_id is only set for a UUID app_user_id so $RCAnonymousID values can
    //    never raise 22P02 here; it is filled in after resolution.
    const appUser = typeof event.app_user_id === "string" ? event.app_user_id : null;
    const { error: insertErr } = await supabase.from("webhook_events").insert({
      event_id:    eventId,
      event_type:  eventType,
      user_id:     appUser && UUID_RE.test(appUser) ? appUser : null,
      product_id:  event.new_product_id ?? event.product_id ?? null,
      environment: rcEnv,
      payload:     event as unknown as Record<string, unknown>,
    });

    if (insertErr) {
      if (insertErr.code === "23505") {
        // Already seen. Re-process only if the prior attempt recorded an error.
        const { data: prior, error: priorErr } = await supabase
          .from("webhook_events")
          .select("error")
          .eq("event_id", eventId)
          .maybeSingle();
        if (priorErr) {
          log("error", "dedupe_read_failed", { ...base, code: priorErr.code });
          return c.json({ error: "Database error" }, 500);
        }
        if (!prior?.error) {
          log("info", "duplicate", base);
          return c.json({ ok: true, duplicate: true });
        }
        log("info", "reprocess_failed_event", base);
        await supabase
          .from("webhook_events")
          .update({ error: null, processed_at: new Date().toISOString() })
          .eq("event_id", eventId);
      } else {
        // Unexpected DB error — surface it so RC retries
        log("error", "insert_failed", { ...base, code: insertErr.code });
        return c.json({ error: "Database error" }, 500);
      }
    }

    const recordError = async (message: string) => {
      await supabase.from("webhook_events").update({ error: message }).eq("event_id", eventId);
    };

    // ── 5. Sandbox gate ─────────────────────────────────────────────────────
    if (rcEnv === "SANDBOX" && !deps.processSandbox()) {
      log("info", "sandbox_recorded_only", base);
      return c.json({ ok: true, sandbox: true });
    }

    // ── 6. Resolve user + process ───────────────────────────────────────────
    let userId: string | null = null;
    try {
      const resolved = await resolveUser(supabase, event);
      if (resolved.userId === null) {
        // Not retryable: RC would deliver the same ids again. Recorded for backfill.
        log("warn", "user_unresolved", { ...base, reason: resolved.reason, app_user: short(appUser) });
        await recordError(`unresolved_user:${resolved.reason}`);
        return c.json({ ok: false, reason: "unresolved_user" });
      }
      userId = resolved.userId;
      const ctx = { ...base, user: short(userId), via: resolved.via };
      if (resolved.via !== "uuid" || appUser?.toLowerCase() !== userId) {
        await supabase.from("webhook_events").update({ user_id: userId }).eq("event_id", eventId);
      }

      const result = await processEvent(supabase, event, userId, ctx);
      if (result.error) {
        await recordError(result.error);
        log("warn", "not_applied", { ...ctx, reason: result.error });
        return c.json({ ok: false, reason: result.error });
      }
      log("info", "done", { ...ctx, outcome: result.outcome });
      return c.json({ ok: true, outcome: result.outcome });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "processing_failed", { ...base, user: short(userId), error: message });
      await recordError(message);
      // Return 500 so RevenueCat retries the delivery
      return c.json({ error: "Processing failed" }, 500);
    }
  });

  return router;
}

type Outcome = { outcome?: string; error?: string };

async function processEvent(
  supabase: SupabaseClient,
  event: RCEvent,
  userId: string,
  ctx: Record<string, unknown>,
): Promise<Outcome> {
  const eventId = event.id;
  const type = event.type;
  const now = new Date().toISOString();

  // ── Credit packs ──────────────────────────────────────────────────────────
  if (PACK_EVENTS.has(type)) {
    const credits = packCreditsFromProductId(event.product_id);
    if (!credits) return { error: `unknown_pack_product:${String(event.product_id ?? "").slice(0, 60)}` };
    const { data, error } = await supabase.rpc("grant_credit_pack", {
      p_user_id: userId, p_credits: credits, p_event_id: eventId, p_product_id: event.product_id,
    });
    if (error) throw fail("grant_credit_pack", error);
    log("info", "pack_granted", { ...ctx, credits, granted: (data as { granted?: boolean } | null)?.granted ?? null });
    return { outcome: "pack" };
  }

  // Current profile state, needed by every subscription branch.
  const { data: profile, error: readErr } = await supabase
    .from("profiles")
    .select("plan, subscription_expires_at, subscription_updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (readErr) throw fail("read_profile", readErr);
  const prevTier = String(profile?.plan ?? "free");
  const currentExpiryMs = msOrNull(profile?.subscription_expires_at as string | null | undefined);
  const lastUpdateMs = msOrNull(profile?.subscription_updated_at as string | null | undefined);
  const eventExpiryMs = finiteMs(event.expiration_at_ms);
  const eventTsMs = finiteMs(event.event_timestamp_ms);

  // ── INITIAL_PURCHASE / RENEWAL / upgrade PRODUCT_CHANGE ───────────────────
  if (ACTIVE_EVENTS.has(type) || CHANGE_EVENTS.has(type)) {
    let productId = event.product_id ?? null;
    if (CHANGE_EVENTS.has(type)) {
      // product_id is the OLD product; new_product_id is where the user is going.
      const next = tierFromProductId(event.new_product_id);
      if (!next) return { error: `unknown_product:${String(event.new_product_id ?? "").slice(0, 60)}` };
      if ((TIER_RANK[next] ?? 0) <= (TIER_RANK[prevTier] ?? 0)) return { outcome: "change_deferred" };
      productId = event.new_product_id ?? null;
    }

    const tier = tierFromProductId(productId);
    if (!tier) return { error: `unknown_product:${String(productId ?? "").slice(0, 60)}` };

    // Out-of-order guard: an older period must not overwrite a newer one.
    // EXPIRATION keeps the ended period's expiry, so a late RENEWAL for that same
    // period cannot resurrect it either.
    if (eventExpiryMs !== null && currentExpiryMs !== null
        && (eventExpiryMs < currentExpiryMs || (eventExpiryMs === currentExpiryMs && prevTier === "free"))) {
      return { outcome: "stale" };
    }

    const { error: profileErr } = await supabase
      .from("profiles")
      .update({
        plan:                    tier,
        subscription_product_id: productId,
        subscription_expires_at: isoOrNull(eventExpiryMs),
        subscription_will_renew: true,
        subscription_updated_at: now,
      })
      .eq("user_id", userId);
    if (profileErr) throw fail("update_profile", profileErr);

    // Grant credits for this period (idempotent via server_grant_subscription_credits).
    // Uses the same request_id keys as the client so whichever side runs first wins.
    const { data: grantData, error: grantErr } = await supabase.rpc("server_grant_subscription_credits", {
      p_user_id: userId, p_plan: tier, p_event_id: eventId,
    });
    if (grantErr) throw fail("grant_subscription_credits", grantErr);
    log("info", "credits", { ...ctx, tier, prev: prevTier, granted: (grantData as { granted?: boolean } | null)?.granted ?? null });

    // Effective downgrade clamp (e.g. Scale→Professional on RENEWAL). CANCELLATION
    // only marks will_renew=false, so the clamp happens when the lower tier is live.
    if ((TIER_RANK[tier] ?? 0) < (TIER_RANK[prevTier] ?? 0)) {
      const cap = TIER_CAP[tier];
      if (cap !== null && cap !== undefined) {
        const { error: clampErr } = await supabase.rpc("clamp_credits_to_cap", {
          p_user_id: userId, p_cap: cap, p_request_id: `downgrade_clamp:${eventId}`,
        });
        if (clampErr) throw fail("clamp_credits_to_cap", clampErr);
        log("info", "downgrade_clamp", { ...ctx, prev: prevTier, tier, cap });
      }
    }
    return { outcome: CHANGE_EVENTS.has(type) ? "upgraded" : "active" };
  }

  // ── CANCELLATION / BILLING_ISSUE / UNCANCELLATION — renewal flag only ─────
  if (RENEW_OFF_EVENTS.has(type) || RENEW_ON_EVENTS.has(type)) {
    // An older event must not undo a state written by a newer one.
    if (eventTsMs !== null && lastUpdateMs !== null && eventTsMs < lastUpdateMs) {
      return { outcome: "stale" };
    }
    const willRenew = RENEW_ON_EVENTS.has(type);
    const { error } = await supabase
      .from("profiles")
      .update({ subscription_will_renew: willRenew, subscription_updated_at: now })
      .eq("user_id", userId);
    if (error) throw fail("update_will_renew", error);
    return { outcome: willRenew ? "renew_on" : "renew_off" };
  }

  // ── EXPIRATION — subscription ended, downgrade to free ───────────────────
  if (INACTIVE_EVENTS.has(type)) {
    // A later period (renewal or re-purchase delivered first) wins.
    if (eventExpiryMs !== null && currentExpiryMs !== null && currentExpiryMs > eventExpiryMs) {
      return { outcome: "stale" };
    }
    const { error: profileErr } = await supabase
      .from("profiles")
      .update({
        plan:                    "free",
        subscription_product_id: null,
        subscription_expires_at: isoOrNull(eventExpiryMs),
        subscription_will_renew: false,
        subscription_updated_at: now,
      })
      .eq("user_id", userId);
    if (profileErr) throw fail("expire_profile", profileErr);

    // Clamp credits to the free-tier cap; event id keeps retries from applying it twice.
    const { error: clampErr } = await supabase.rpc("clamp_credits_to_free_tier", {
      p_user_id: userId, p_request_id: `downgrade_clamp:${eventId}`,
    });
    if (clampErr) throw fail("clamp_credits_to_free_tier", clampErr);
    return { outcome: "expired" };
  }

  return { outcome: "ignored" };
}

export const revenuecatWebhookRouter = createRevenuecatWebhookRouter();
