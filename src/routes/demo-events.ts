/**
 * Demo-page measurement: page views and App Store CTA taps, per email step.
 *
 * One JSON line per event on stdout, so Railway logs hold them and
 * scripts/demo-stats.ts can count them. Deliberately coarse: the email step
 * (normalised ?ct=), which CTA, mobile/desktop/bot, and a timestamp. No
 * cookies, no IPs, no raw user agent, no raw query values, no third parties.
 *
 * CTA taps arrive two ways and each tap produces exactly one line:
 *  - no JS: the button href is GET /go?ct=..&cta=.., which logs and 302s to
 *    the App Store;
 *  - JS: the page swaps the href to the App Store URL itself (no redirect hop)
 *    and fires navigator.sendBeacon(POST /go?ct=..&cta=..) on click.
 * /go only ever redirects to the fixed App Store URL, never to a parameter
 * (Apple campaign params are built from the normalised step, see storeHref).
 */
import { Hono } from "hono";
import type { Context } from "hono";
export const APP_STORE_URL = "https://apps.apple.com/us/app/stagewell/id6757572170";
export const STORE_HREF = `${APP_STORE_URL}?ct=demo`;

/**
 * App Store Connect campaign attribution (App Analytics > Campaigns). Apple only
 * attributes a download when the link carries `pt` (the developer account's
 * provider token) and `ct` (campaign token, <= 40 chars). The provider token is
 * not exposed by the ASC API, so it comes from STAGEWELL_APPLE_PT, read per
 * request. Unset or not a plain number: links stay exactly STORE_HREF.
 */
const PT_RE = /^[0-9]{1,20}$/;

export function applePt(): string | null {
  const v = (process.env.STAGEWELL_APPLE_PT ?? "").trim();
  return PT_RE.test(v) ? v : null;
}

/** demo_<step>; the step is already an enum, the sanitise + cap is belt and braces. */
export function campaignToken(step: DemoStep): string {
  return `demo_${step}`.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}

/** App Store URL for a CTA tap from this email step. Host is always APP_STORE_URL's. */
export function storeHref(step: DemoStep): string {
  const pt = applePt();
  if (!pt) return STORE_HREF;
  return `${APP_STORE_URL}?pt=${pt}&ct=${campaignToken(step)}&mt=8`;
}

export type DemoStep = "email1" | "email2" | "email3" | "email4" | "none" | "other";
export type DemoCta = "top" | "hero" | "close" | "other";
export type UaClass = "mobile" | "desktop" | "bot";
export type DemoRoute = "/" | "/demo" | "/l/demo";

export interface DemoEvent {
  message: "demo_event"; // Railway shows `message` as the log text; the rest become attributes
  level: "info";
  evt: "view" | "cta";
  ct: DemoStep;
  ua: UaClass;
  ts: string; // ISO 8601, UTC
  route?: DemoRoute; // views only
  cta?: DemoCta; // taps only
  via?: "redirect" | "beacon"; // taps only
}

const STEP_RE = /^email[1-4]$/;
const CTAS = new Set<DemoCta>(["top", "hero", "close"]);

/** Smartlead tags the CTA ?ct=email1..4; anything else collapses so raw input never reaches a log. */
export function normalizeCt(raw: string | undefined | null): DemoStep {
  if (raw == null || raw === "") return "none";
  const v = raw.trim().toLowerCase();
  return STEP_RE.test(v) ? (v as DemoStep) : "other";
}

export function normalizeCta(raw: string | undefined | null): DemoCta {
  return raw && CTAS.has(raw as DemoCta) ? (raw as DemoCta) : "other";
}

// Link scanners (Outlook Safe Links, Proofpoint, Mimecast…), crawlers, and HTTP libraries.
const BOT_RE = /bot|crawl|spider|slurp|preview|scanner|monitor|headless|lighthouse|python|curl|wget|httpclient|okhttp|go-http|java\/|axios|node-fetch|undici|libwww|proofpoint|mimecast|barracuda|safelinks/i;
const MOBILE_RE = /mobi|iphone|ipod|ipad|android|silk|kindle|blackberry|opera mini|iemobile/i;

/** Coarse class only; the raw user agent is never logged. Empty UA counts as a bot. */
export function classifyUa(ua: string | undefined | null): UaClass {
  if (!ua || BOT_RE.test(ua)) return "bot";
  return MOBILE_RE.test(ua) ? "mobile" : "desktop";
}

export function emitDemoEvent(e: DemoEvent): void {
  console.log(JSON.stringify(e));
}

/** Logs a page view for GET (not HEAD — prefetch/uptime checks aren't views). */
export function logDemoView(c: Context, route: DemoRoute): void {
  if (c.req.method !== "GET") return;
  emitDemoEvent({
    message: "demo_event",
    level: "info",
    evt: "view",
    ct: normalizeCt(c.req.query("ct")),
    ua: classifyUa(c.req.header("user-agent")),
    ts: new Date().toISOString(),
    route,
  });
}

function logTap(c: Context, via: "redirect" | "beacon"): void {
  emitDemoEvent({
    message: "demo_event",
    level: "info",
    evt: "cta",
    ct: normalizeCt(c.req.query("ct")),
    ua: classifyUa(c.req.header("user-agent")),
    ts: new Date().toISOString(),
    cta: normalizeCta(c.req.query("cta")),
    via,
  });
}

export const demoGoRouter = new Hono();

// No-JS path. HEAD gets the same redirect but is not counted.
demoGoRouter.get("/", (c) => {
  if (c.req.method === "GET") logTap(c, "redirect");
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  return c.redirect(storeHref(normalizeCt(c.req.query("ct"))), 302);
});

// sendBeacon path. Body is ignored (never read); the answer is empty.
demoGoRouter.post("/", (c) => {
  logTap(c, "beacon");
  c.header("Cache-Control", "no-store");
  return c.body(null, 204);
});
