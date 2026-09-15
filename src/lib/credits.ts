/**
 * Server-side credit ledger operations (service role).
 *
 * Mirrors the client-side consumeCredit() contract so the ledger stays
 * consistent while old app builds (which still write the ledger directly)
 * and the proxy coexist:
 *   - consume:  delta -1, reason 'generate', meta.request_id = <key>
 *   - refund:   delta +1, reason 'refund',   meta.request_id = 'refund:<key>'
 *
 * Both are idempotent thanks to the unique partial index
 * idx_credit_ledger_meta_request_id on (user_id, meta->>'request_id').
 *
 * When the consume_credit_v2 SQL function exists (migration
 * 20260914_consume_credit_v2_and_generations.sql) it is used because it
 * serialises per user with an advisory lock. Until that migration is applied
 * we fall back to the legacy multi-step path, serialised per user *inside this
 * process* so concurrent requests from one device cannot drive the balance
 * negative (single Railway instance).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ConsumeStatus = "ok" | "already_processed" | "no_credits" | "error";

export interface ConsumeResult {
  status: ConsumeStatus;
  balance: number | null;
  message?: string;
}

const MISSING_FUNCTION_CODES = new Set(["42883", "PGRST202"]);

// ─── Per-user in-process mutex for the legacy path ───────────────────────────
const userLocks = new Map<string, Promise<void>>();

async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const chained = prev.then(() => next);
  userLocks.set(userId, chained);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (userLocks.get(userId) === chained) userLocks.delete(userId);
  }
}

let warnedLegacy = false;

export async function getBalance(admin: SupabaseClient, userId: string): Promise<number | null> {
  const { data, error } = await admin.rpc("get_user_credit_balance", { p_user_id: userId });
  if (error) {
    console.error(`[Credits] get_user_credit_balance failed for ${userId}: ${error.message}`);
    return null;
  }
  return typeof data === "number" ? data : Number(data ?? 0);
}

/** True when a 'generate' ledger row exists for this key. */
export async function hasConsumeRow(admin: SupabaseClient, userId: string, key: string): Promise<boolean> {
  const { data } = await admin
    .from("credit_ledger")
    .select("id")
    .eq("user_id", userId)
    .eq("reason", "generate")
    .filter("meta->>request_id", "eq", key)
    .limit(1);
  return Boolean(data && data.length > 0);
}

/** True when a refund row exists for this key (i.e. a previous attempt failed and was refunded). */
export async function hasRefundRow(admin: SupabaseClient, userId: string, key: string): Promise<boolean> {
  const { data } = await admin
    .from("credit_ledger")
    .select("id")
    .eq("user_id", userId)
    .filter("meta->>request_id", "eq", `refund:${key}`)
    .limit(1);
  return Boolean(data && data.length > 0);
}

export async function consumeCredit(
  admin: SupabaseClient,
  userId: string,
  key: string,
  meta: Record<string, string>,
): Promise<ConsumeResult> {
  const fullMeta = { ...meta, request_id: key, source: meta.source ?? "proxy" };

  // ── Preferred: atomic server function ────────────────────────────────────
  const v2 = await admin.rpc("consume_credit_v2", {
    p_user: userId,
    p_request_id: key,
    p_meta: fullMeta,
  });
  if (!v2.error) {
    const row = v2.data as { status?: string; balance?: number } | null;
    const status = (row?.status ?? "error") as ConsumeStatus;
    return { status, balance: typeof row?.balance === "number" ? row.balance : null };
  }
  if (!MISSING_FUNCTION_CODES.has(v2.error.code ?? "")) {
    console.error(`[Credits] consume_credit_v2 failed: code=${v2.error.code} msg=${v2.error.message}`);
    return { status: "error", balance: null, message: v2.error.message };
  }

  // ── Fallback: legacy multi-step path, serialised per user ────────────────
  if (!warnedLegacy) {
    warnedLegacy = true;
    console.warn("[Credits] consume_credit_v2 is missing — using the legacy consume path. Apply migration 20260914_consume_credit_v2_and_generations.sql.");
  }

  return withUserLock(userId, async () => {
    if (await hasConsumeRow(admin, userId, key)) {
      return { status: "already_processed" as const, balance: await getBalance(admin, userId) };
    }

    const balance = await getBalance(admin, userId);
    if (balance === null) {
      return { status: "error" as const, balance: null, message: "Could not read balance" };
    }
    if (balance <= 0) {
      return { status: "no_credits" as const, balance };
    }

    const { error } = await admin.rpc("add_credits", {
      p_user_id: userId,
      p_amount: -1,
      p_reason: "generate",
      p_meta: fullMeta,
    });
    if (error) {
      console.error(`[Credits] add_credits(-1) failed: code=${error.code} msg=${error.message}`);
      return { status: "error" as const, balance, message: error.message };
    }
    // add_credits uses ON CONFLICT DO NOTHING, so it never signals a duplicate.
    // Confirm our row exists; if it does not, something else went wrong.
    if (!(await hasConsumeRow(admin, userId, key))) {
      return { status: "error" as const, balance, message: "Ledger row was not written" };
    }
    return { status: "ok" as const, balance: balance - 1 };
  });
}

/**
 * Refund one credit for a failed generation. Idempotent per key.
 * Returns the new balance when known.
 */
export async function refundCredit(
  admin: SupabaseClient,
  userId: string,
  key: string,
  meta: Record<string, string>,
): Promise<number | null> {
  const { error } = await admin.rpc("add_credits", {
    p_user_id: userId,
    p_amount: 1,
    p_reason: "refund",
    p_meta: { ...meta, request_id: `refund:${key}`, refunded_request_id: key, source: "proxy" },
  });
  if (error && error.code !== "23505") {
    console.error(`[Credits] refund failed for ${userId}/${key}: code=${error.code} msg=${error.message}`);
    return null;
  }
  return getBalance(admin, userId);
}
