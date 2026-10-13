import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  authorized,
  createRevenuecatWebhookRouter,
  packCreditsFromProductId,
  tierFromProductId,
  type RCEvent,
} from "./routes/webhook-revenuecat";

const SECRET = "test_secret_value_1234567890abc";
const USER = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";
const ANON = "$RCAnonymousID:2a6059a728004b34ae2ff93c848137df";
const DAY = 86_400_000;

type Row = Record<string, any>;
type Rpc = { name: string; args: Row };

/** In-memory stand-in for the slice of supabase-js the handler uses. */
class FakeDb {
  tables: { webhook_events: Row[]; profiles: Row[]; subscription_claims: Row[] } = { webhook_events: [], profiles: [], subscription_claims: [] };
  rpcs: Rpc[] = [];
  rpcError: Record<string, { code: string; message: string } | undefined> = {};
  insertError: { code: string; message: string } | null = null;

  client(): SupabaseClient {
    const db = this;
    return {
      from(table: string) {
        return new Query(db, table);
      },
      async rpc(name: string, args: Row) {
        db.rpcs.push({ name, args });
        const err = db.rpcError[name];
        if (err) return { data: null, error: err };
        return { data: { granted: true }, error: null };
      },
    } as unknown as SupabaseClient;
  }

  profile(id: string) {
    return this.tables.profiles.find((r) => r.user_id === id);
  }
  event(id: string) {
    return this.tables.webhook_events.find((r) => r.event_id === id);
  }
}

class Query {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row = {};
  private row: Row | null = null;
  constructor(private db: FakeDb, private table: string) {}
  select() { this.op = "select"; return this; }
  insert(row: Row) { this.op = "insert"; this.row = row; return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
  eq(k: string, v: unknown) { this.filters.push((r) => r[k] === v); return this; }
  in(k: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[k])); return this; }
  private get t(): Row[] { return (this.db.tables as Record<string, Row[]>)[this.table] ?? []; }
  private rows() { return this.t.filter((r) => this.filters.every((f) => f(r))); }
  async maybeSingle() { return { data: this.rows()[0] ?? null, error: null }; }
  then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
    try {
      resolve(this.exec());
    } catch (e) {
      reject?.(e);
    }
  }
  private exec() {
    const t = this.t;
    if (this.op === "insert") {
      if (this.db.insertError) return { error: this.db.insertError };
      if (this.table === "webhook_events" && t.some((r) => r.event_id === this.row!.event_id)) {
        return { error: { code: "23505", message: "duplicate key" } };
      }
      if (this.row!.user_id !== null && this.row!.user_id !== undefined && !/^[0-9a-f-]{36}$/i.test(this.row!.user_id)) {
        return { error: { code: "22P02", message: "invalid input syntax for type uuid" } };
      }
      t.push({ error: null, ...this.row });
      return { error: null };
    }
    if (this.op === "update") {
      for (const r of this.rows()) Object.assign(r, this.patch);
      return { error: null };
    }
    return { data: this.rows(), error: null };
  }
}

let db: FakeDb;
let sandbox = false;
let secret: string | undefined = SECRET;
let production = true;
let app: Hono;
let logSpies: Array<ReturnType<typeof spyOn>> = [];
let logged: string[] = [];

beforeEach(() => {
  db = new FakeDb();
  sandbox = false;
  secret = SECRET;
  production = true;
  app = new Hono();
  app.route(
    "/api/webhooks/revenuecat",
    createRevenuecatWebhookRouter({
      getSupabase: () => db.client(),
      getSecret: () => secret,
      processSandbox: () => sandbox,
      isProduction: () => production,
    }),
  );
  logged = [];
  logSpies = (["log", "warn", "error"] as const).map((m) =>
    spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); }),
  );
});
afterEach(() => logSpies.forEach((s) => s.mockRestore()));

let seq = 0;
function ev(over: Partial<RCEvent> = {}): RCEvent {
  return {
    id: `evt_${++seq}`,
    type: "INITIAL_PURCHASE",
    app_user_id: USER,
    original_app_user_id: USER,
    aliases: [USER],
    product_id: "professional_monthly_19",
    expiration_at_ms: Date.now() + 30 * DAY,
    event_timestamp_ms: Date.now(),
    environment: "PRODUCTION",
    store: "APP_STORE",
    ...over,
  };
}

async function post(event: unknown, auth: string | null = SECRET) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  const res = await app.fetch(new Request("http://localhost/api/webhooks/revenuecat", {
    method: "POST", headers, body: typeof event === "string" ? event : JSON.stringify({ api_version: "1.0", event }),
  }));
  return { status: res.status, body: (await res.json()) as Row };
}

function seedProfile(over: Row = {}) {
  db.tables.profiles.push({ user_id: USER, plan: "free", subscription_expires_at: null, subscription_updated_at: null, ...over });
}

describe("helpers", () => {
  test("tierFromProductId uses the explicit table and refuses unknown products", () => {
    expect(tierFromProductId("professional_monthly_19")).toBe("professional");
    expect(tierFromProductId("scale_monthly_39")).toBe("scale");
    expect(tierFromProductId("unlimited_monthly_99")).toBe("unlimited");
    expect(tierFromProductId("credits_10")).toBeNull();
    expect(tierFromProductId("something_else")).toBeNull();
    expect(tierFromProductId(null)).toBeNull();
  });
  test("pack credits come from the product definitions", () => {
    expect(packCreditsFromProductId("credits_10")).toBe(10);
    expect(packCreditsFromProductId("credits_25")).toBe(25);
    expect(packCreditsFromProductId("credits_50")).toBe(50);
    expect(packCreditsFromProductId("credits_pack_20")).toBe(20);
    expect(packCreditsFromProductId("credits_999")).toBeNull();
  });
  test("authorized accepts raw and Bearer, rejects everything else", () => {
    expect(authorized(SECRET, SECRET)).toBe(true);
    expect(authorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(authorized(`bearer  ${SECRET}`, SECRET)).toBe(true);
    expect(authorized(undefined, SECRET)).toBe(false);
    expect(authorized("", SECRET)).toBe(false);
    expect(authorized(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(authorized(`${SECRET}x`, SECRET)).toBe(false);
    expect(authorized("Bearer", SECRET)).toBe(false);
  });
});

describe("auth", () => {
  test("missing or wrong Authorization → 401, nothing written", async () => {
    expect((await post(ev(), null)).status).toBe(401);
    expect((await post(ev(), "wrong")).status).toBe(401);
    expect(db.tables.webhook_events.length).toBe(0);
  });
  test("Bearer form is accepted", async () => {
    seedProfile();
    expect((await post(ev(), `Bearer ${SECRET}`)).status).toBe(200);
  });
  test("secret unset in production → 503; in dev → processed", async () => {
    secret = undefined;
    expect((await post(ev())).status).toBe(503);
    production = false;
    seedProfile();
    expect((await post(ev(), null)).status).toBe(200);
  });
  test("secret never appears in logs", async () => {
    await post(ev(), "wrong");
    seedProfile();
    await post(ev());
    expect(logged.join("\n")).not.toContain(SECRET);
  });
});

describe("validation", () => {
  test("bad JSON → 400; missing id/type → 400", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ type: "RENEWAL" })).status).toBe(400);
    expect((await post({ id: "x" })).status).toBe(400);
    expect((await post({ id: 5, type: "RENEWAL" })).status).toBe(400);
  });
  test("TEST / TRANSFER are acknowledged without DB writes", async () => {
    for (const type of ["TEST", "TRANSFER", "SUBSCRIPTION_EXTENDED"]) {
      const r = await post(ev({ type }));
      expect(r.status).toBe(200);
      expect(r.body.skipped).toBe(true);
    }
    expect(db.tables.webhook_events.length).toBe(0);
  });
});

describe("subscription lifecycle", () => {
  test("INITIAL_PURCHASE sets plan + expiry and grants credits", async () => {
    seedProfile();
    const e = ev();
    const r = await post(e);
    expect(r).toEqual({ status: 200, body: { ok: true, outcome: "active" } });
    const p = db.profile(USER)!;
    expect(p.plan).toBe("professional");
    expect(p.subscription_product_id).toBe("professional_monthly_19");
    expect(p.subscription_expires_at).toBe(new Date(e.expiration_at_ms!).toISOString());
    expect(p.subscription_will_renew).toBe(true);
    expect(db.rpcs).toEqual([{ name: "server_grant_subscription_credits", args: { p_user_id: USER, p_plan: "professional", p_event_id: e.id } }]);
    expect(db.event(e.id)!.error).toBeNull();
  });

  test("duplicate delivery is a no-op", async () => {
    seedProfile();
    const e = ev();
    await post(e);
    const again = await post(e);
    expect(again.body.duplicate).toBe(true);
    expect(db.rpcs.length).toBe(1);
    expect(db.tables.webhook_events.length).toBe(1);
  });

  test("a previously failed event is re-processed on redelivery", async () => {
    seedProfile();
    const e = ev();
    db.rpcError.server_grant_subscription_credits = { code: "XX000", message: "boom" };
    expect((await post(e)).status).toBe(500);
    expect(db.event(e.id)!.error).toContain("boom");
    db.rpcError.server_grant_subscription_credits = undefined;
    const r = await post(e);
    expect(r.status).toBe(200);
    expect(db.event(e.id)!.error).toBeNull();
  });

  test("RENEWAL downgrade Scale→Professional clamps to 20", async () => {
    seedProfile({ plan: "scale", subscription_expires_at: new Date(Date.now() - DAY).toISOString() });
    const e = ev({ type: "RENEWAL" });
    await post(e);
    expect(db.profile(USER)!.plan).toBe("professional");
    expect(db.rpcs.map((x) => x.name)).toEqual(["server_grant_subscription_credits", "clamp_credits_to_cap"]);
    expect(db.rpcs[1]?.args).toEqual({ p_user_id: USER, p_cap: 20, p_request_id: `downgrade_clamp:${e.id}` });
  });

  test("out-of-order: older RENEWAL after a newer one does not overwrite", async () => {
    seedProfile();
    const newer = ev({ type: "RENEWAL", product_id: "scale_monthly_39", expiration_at_ms: Date.now() + 60 * DAY });
    const older = ev({ type: "RENEWAL", product_id: "professional_monthly_19", expiration_at_ms: Date.now() + 30 * DAY });
    await post(newer);
    const r = await post(older);
    expect(r.body.outcome).toBe("stale");
    expect(db.profile(USER)!.plan).toBe("scale");
    expect(db.rpcs.filter((x) => x.name === "clamp_credits_to_cap").length).toBe(0);
  });

  test("out-of-order: EXPIRATION of an old period after a renewal is ignored", async () => {
    seedProfile();
    const renew = ev({ type: "RENEWAL", expiration_at_ms: Date.now() + 30 * DAY });
    const oldExp = ev({ type: "EXPIRATION", expiration_at_ms: Date.now() - DAY });
    await post(renew);
    const r = await post(oldExp);
    expect(r.body.outcome).toBe("stale");
    expect(db.profile(USER)!.plan).toBe("professional");
    expect(db.rpcs.some((x) => x.name === "clamp_credits_to_free_tier")).toBe(false);
  });

  test("EXPIRATION downgrades to free and a late RENEWAL for that period cannot resurrect it", async () => {
    const exp = Date.now() - 1000;
    seedProfile({ plan: "professional", subscription_expires_at: new Date(exp).toISOString() });
    const e = ev({ type: "EXPIRATION", expiration_at_ms: exp });
    expect((await post(e)).body.outcome).toBe("expired");
    const p = db.profile(USER)!;
    expect(p.plan).toBe("free");
    expect(p.subscription_will_renew).toBe(false);
    expect(db.rpcs).toEqual([{ name: "clamp_credits_to_free_tier", args: { p_user_id: USER, p_request_id: `downgrade_clamp:${e.id}` } }]);
    const late = await post(ev({ type: "RENEWAL", expiration_at_ms: exp }));
    expect(late.body.outcome).toBe("stale");
    expect(db.profile(USER)!.plan).toBe("free");
  });

  test("EXPIRATION when client set plan without expiry still downgrades", async () => {
    seedProfile({ plan: "professional" });
    await post(ev({ type: "EXPIRATION", expiration_at_ms: Date.now() - DAY }));
    expect(db.profile(USER)!.plan).toBe("free");
  });

  test("CANCELLATION / BILLING_ISSUE / UNCANCELLATION toggle will_renew only", async () => {
    seedProfile({ plan: "scale" });
    await post(ev({ type: "CANCELLATION", event_timestamp_ms: Date.now() + 1000 }));
    expect(db.profile(USER)!.subscription_will_renew).toBe(false);
    expect(db.profile(USER)!.plan).toBe("scale");
    await post(ev({ type: "UNCANCELLATION", event_timestamp_ms: Date.now() + 2000 }));
    expect(db.profile(USER)!.subscription_will_renew).toBe(true);
    await post(ev({ type: "BILLING_ISSUE", event_timestamp_ms: Date.now() + 3000 }));
    expect(db.profile(USER)!.subscription_will_renew).toBe(false);
    expect(db.rpcs.length).toBe(0);
  });

  test("a CANCELLATION made while a RENEWAL was in retry still applies", async () => {
    seedProfile();
    await post(ev({ type: "RENEWAL", event_timestamp_ms: Date.now() - 120_000 }));
    const r = await post(ev({ type: "CANCELLATION", event_timestamp_ms: Date.now() - 60_000 }));
    expect(r.body.outcome).toBe("renew_off");
    expect(db.profile(USER)!.subscription_will_renew).toBe(false);
  });

  test("refund EXPIRATION (CUSTOMER_SUPPORT) downgrades even mid-period", async () => {
    seedProfile();
    await post(ev({ expiration_at_ms: Date.now() + 30 * DAY }));
    const r = await post(ev({ type: "EXPIRATION", expiration_at_ms: Date.now() - 1000, expiration_reason: "CUSTOMER_SUPPORT" }));
    expect(r.body.outcome).toBe("expired");
    expect(db.profile(USER)!.plan).toBe("free");
  });

  test("garbage expiration_at_ms never 500s", async () => {
    seedProfile();
    for (const bad of [1e20, -5, "soon"] as unknown[]) {
      const r = await post(ev({ type: "RENEWAL", expiration_at_ms: bad as number }));
      expect(r.status).toBe(200);
    }
    const r = await post(ev({ type: "EXPIRATION", expiration_at_ms: 1e20 }));
    expect(r.status).toBe(200);
  });

  test("non-string product_id is recorded, not a 500", async () => {
    seedProfile();
    for (const type of ["NON_RENEWING_PURCHASE", "RENEWAL"]) {
      const r = await post(ev({ type, product_id: 10 as unknown as string }));
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
    }
    expect(db.rpcs.length).toBe(0);
  });

  test("PRODUCT_CHANGE: upgrade applies new_product_id, downgrade waits for RENEWAL", async () => {
    seedProfile({ plan: "professional" });
    const up = await post(ev({ type: "PRODUCT_CHANGE", product_id: "professional_monthly_19", new_product_id: "unlimited_monthly_99" }));
    expect(up.body.outcome).toBe("upgraded");
    expect(db.profile(USER)!.plan).toBe("unlimited");
    expect(db.profile(USER)!.subscription_product_id).toBe("unlimited_monthly_99");
    const down = await post(ev({ type: "PRODUCT_CHANGE", product_id: "unlimited_monthly_99", new_product_id: "scale_monthly_39" }));
    expect(down.body.outcome).toBe("change_deferred");
    expect(db.profile(USER)!.plan).toBe("unlimited");
    expect(db.rpcs.some((x) => x.name.startsWith("clamp"))).toBe(false);
  });

  test("unknown subscription product is recorded, plan untouched, no retry", async () => {
    seedProfile();
    const e = ev({ product_id: "mystery_annual" });
    const r = await post(e);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(db.profile(USER)!.plan).toBe("free");
    expect(db.event(e.id)!.error).toBe("unknown_product:mystery_annual");
  });
});

describe("credit packs", () => {
  test("NON_RENEWING_PURCHASE grants the pack amount via grant_credit_pack", async () => {
    seedProfile();
    const e = ev({ type: "NON_RENEWING_PURCHASE", product_id: "credits_25", expiration_at_ms: null });
    const r = await post(e);
    expect(r.body).toEqual({ ok: true, outcome: "pack" });
    expect(db.rpcs).toEqual([{ name: "grant_credit_pack", args: { p_user_id: USER, p_credits: 25, p_event_id: e.id, p_product_id: "credits_25" } }]);
    expect(db.profile(USER)!.plan).toBe("free");
  });
  test("unknown pack product is recorded without a grant", async () => {
    seedProfile();
    const e = ev({ type: "NON_RENEWING_PURCHASE", product_id: "credits_1000" });
    expect((await post(e)).body.ok).toBe(false);
    expect(db.rpcs.length).toBe(0);
    expect(db.event(e.id)!.error).toBe("unknown_pack_product:credits_1000");
  });
});

describe("user resolution", () => {
  test("$RCAnonymousID with a UUID alias resolves to that user", async () => {
    seedProfile();
    const e = ev({ type: "RENEWAL", app_user_id: ANON, original_app_user_id: ANON, aliases: [ANON, USER] });
    const r = await post(e);
    expect(r.body.ok).toBe(true);
    expect(db.profile(USER)!.plan).toBe("professional");
    expect(db.event(e.id)!.user_id).toBe(USER);
  });

  test("$RCAnonymousID with a subscription_claims row resolves via the claim", async () => {
    seedProfile();
    db.tables.subscription_claims.push({ rc_app_user_id: ANON, supabase_user_id: USER });
    const e = ev({ type: "RENEWAL", app_user_id: ANON, original_app_user_id: ANON, aliases: [ANON] });
    expect((await post(e)).body.ok).toBe(true);
    expect(db.profile(USER)!.plan).toBe("professional");
  });

  test("unclaimed $RCAnonymousID is recorded, 200, no mutation", async () => {
    seedProfile();
    const e = ev({ type: "RENEWAL", app_user_id: ANON, original_app_user_id: ANON, aliases: [ANON] });
    const r = await post(e);
    expect(r).toEqual({ status: 200, body: { ok: false, reason: "unresolved_user" } });
    expect(db.event(e.id)!.error).toBe("unresolved_user:anonymous_unclaimed");
    expect(db.event(e.id)!.user_id).toBeNull();
    expect(db.rpcs.length).toBe(0);
  });

  test("missing app_user_id is recorded, not a 400/500", async () => {
    const e = ev({ app_user_id: undefined, original_app_user_id: undefined, aliases: undefined });
    const r = await post(e);
    expect(r.status).toBe(200);
    expect(db.event(e.id)!.error).toBe("unresolved_user:no_user_id");
  });

  test("prefers the alias that has a profile row", async () => {
    seedProfile();
    const e = ev({ app_user_id: OTHER, original_app_user_id: OTHER, aliases: [OTHER, USER] });
    await post(e);
    expect(db.profile(USER)!.plan).toBe("professional");
    expect(db.event(e.id)!.user_id).toBe(USER);
  });

  test("anonymous ids are not logged in full", async () => {
    await post(ev({ app_user_id: ANON, original_app_user_id: ANON, aliases: [ANON] }));
    expect(logged.join("\n")).not.toContain("2a6059a728004b34ae2ff93c848137df");
  });
});

describe("deleted / ambiguous users", () => {
  test("UUID with no profile (deleted account) → 200 recorded, no RPC, no FK write", async () => {
    const e = ev({ app_user_id: OTHER, original_app_user_id: OTHER, aliases: [OTHER] });
    const r = await post(e);
    expect(r).toEqual({ status: 200, body: { ok: false, reason: "unresolved_user" } });
    expect(db.event(e.id)!.error).toBe("unresolved_user:no_profile");
    expect(db.event(e.id)!.user_id).toBeNull();
    expect(db.rpcs.length).toBe(0);
  });
  test("$RCAnonymousID aliased to a deleted account → 200 recorded", async () => {
    const e = ev({ app_user_id: ANON, original_app_user_id: ANON, aliases: [ANON, OTHER] });
    expect((await post(e)).status).toBe(200);
    expect(db.event(e.id)!.error).toBe("unresolved_user:no_profile");
  });
  test("two aliased accounts with profiles and an anonymous app_user_id → ambiguous", async () => {
    seedProfile();
    db.tables.profiles.push({ user_id: OTHER, plan: "free", subscription_expires_at: null });
    const e = ev({ app_user_id: ANON, original_app_user_id: ANON, aliases: [ANON, OTHER, USER] });
    expect((await post(e)).body.reason).toBe("unresolved_user");
    expect(db.event(e.id)!.error).toBe("unresolved_user:ambiguous_alias");
    expect(db.rpcs.length).toBe(0);
  });
  test("app_user_id with a profile wins over other aliased accounts", async () => {
    seedProfile();
    db.tables.profiles.push({ user_id: OTHER, plan: "free", subscription_expires_at: null });
    await post(ev({ app_user_id: USER, aliases: [OTHER, USER] }));
    expect(db.profile(USER)!.plan).toBe("professional");
    expect(db.profile(OTHER)!.plan).toBe("free");
  });
  test("uppercase UUID resolves to the lowercase profile", async () => {
    seedProfile();
    await post(ev({ app_user_id: USER.toUpperCase(), original_app_user_id: null, aliases: null }));
    expect(db.profile(USER)!.plan).toBe("professional");
  });
});

describe("environments", () => {
  test("SANDBOX is recorded but never mutates by default", async () => {
    seedProfile();
    const e = ev({ environment: "SANDBOX" });
    const r = await post(e);
    expect(r.body).toEqual({ ok: true, sandbox: true });
    expect(db.event(e.id)!.environment).toBe("SANDBOX");
    expect(db.profile(USER)!.plan).toBe("free");
    expect(db.rpcs.length).toBe(0);
  });
  test("SANDBOX mutates when REVENUECAT_PROCESS_SANDBOX is on", async () => {
    sandbox = true;
    seedProfile();
    await post(ev({ environment: "SANDBOX" }));
    expect(db.profile(USER)!.plan).toBe("professional");
  });
  test("missing or odd environment is treated as sandbox", async () => {
    seedProfile();
    for (const environment of [undefined, "sandbox", "production", "STAGING"]) {
      const r = await post(ev({ environment: environment as RCEvent["environment"] }));
      expect(r.body.sandbox).toBe(true);
    }
    expect(db.profile(USER)!.plan).toBe("free");
  });
  test("oversized body → 4xx without a DB write (413 when content-length is sent)", async () => {
    const body = JSON.stringify({ event: { ...ev(), pad: "x".repeat(300 * 1024) } });
    const send = (headers: Record<string, string>) => app.fetch(new Request("http://localhost/api/webhooks/revenuecat", {
      method: "POST", headers: { "content-type": "application/json", authorization: SECRET, ...headers }, body,
    }));
    expect((await send({ "content-length": String(body.length) })).status).toBe(413);
    const streamed = (await send({})).status;
    expect(streamed === 400 || streamed === 413).toBe(true);
    expect(db.tables.webhook_events.length).toBe(0);
  });
  test("insert failure other than duplicate → 500 so RC retries", async () => {
    db.insertError = { code: "08006", message: "connection failure" };
    expect((await post(ev())).status).toBe(500);
  });
});
