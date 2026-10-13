import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import server from "./index";
import { APP_STORE_URL, applePt, campaignToken, classifyUa, normalizeCt, normalizeCta, storeHref, STORE_HREF } from "./routes/demo-events";
import { parseEvent, summarize } from "../scripts/demo-stats";

const RAILWAY = "stagewell-backend-production.up.railway.app";
const DEMO = "demo.stagewell.app";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const STORE = "https://apps.apple.com/us/app/stagewell/id6757572170?ct=demo";

function req(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return server.fetch(new Request(`http://localhost${path}`, { method: init.method ?? "GET", headers: { host: DEMO, "user-agent": IPHONE, ...init.headers } }));
}

let lines: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  lines = [];
  spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
});
afterEach(() => spy.mockRestore());

/** Only our structured lines (hono/logger also writes through console.log). */
const events = () => lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

describe("normalisers", () => {
  test("ct collapses to a fixed enum", () => {
    expect(normalizeCt("email1")).toBe("email1");
    expect(normalizeCt(" EMAIL4 ")).toBe("email4");
    expect(normalizeCt(undefined)).toBe("none");
    expect(normalizeCt("")).toBe("none");
    for (const bad of ["email5", "email0", "demo", "email1x", "<script>", "a".repeat(10000), "email1\n{\"evt\":\"cta\"}"]) {
      expect(normalizeCt(bad)).toBe("other");
    }
    expect(normalizeCta("hero")).toBe("hero");
    expect(normalizeCta("x".repeat(500))).toBe("other");
  });

  test("user agent → mobile / desktop / bot only", () => {
    expect(classifyUa(IPHONE)).toBe("mobile");
    expect(classifyUa("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/129 Mobile Safari/537.36")).toBe("mobile");
    expect(classifyUa(MAC)).toBe("desktop");
    for (const b of [undefined, "", "curl/8.7.1", "Googlebot/2.1", "python-requests/2.32", "Mozilla/5.0 HeadlessChrome/129"]) {
      expect(classifyUa(b)).toBe("bot");
    }
  });
});

describe("page views", () => {
  test("one line per GET with the exact allowed shape", async () => {
    expect((await req("/?ct=email2")).status).toBe(200);
    const ev = events();
    expect(ev.length).toBe(1);
    expect(Object.keys(ev[0]).sort()).toEqual(["ct", "evt", "level", "message", "route", "ts", "ua"]);
    expect(ev[0]).toMatchObject({ message: "demo_event", level: "info", evt: "view", ct: "email2", ua: "mobile", route: "/" });
    expect(new Date(ev[0].ts).toISOString()).toBe(ev[0].ts);
  });

  test("all three demo routes log their route; Railway-host root logs nothing and stays 404", async () => {
    await req("/demo?ct=email3", { headers: { "user-agent": MAC } });
    await req("/l/demo");
    const res = await req("/", { headers: { host: RAILWAY } });
    expect(res.status).toBe(404);
    expect(events().map((e) => [e.route, e.ct, e.ua])).toEqual([["/demo", "email3", "desktop"], ["/l/demo", "none", "mobile"]]);
  });

  test("HEAD is not a view", async () => {
    expect((await req("/?ct=email1", { method: "HEAD" })).status).toBe(200);
    expect(events().length).toBe(0);
  });

  test("raw ct, user agent, IPs and cookies never reach the log or the response", async () => {
    const huge = "email1" + "Z".repeat(20000);
    const res = await req(`/?ct=${encodeURIComponent(huge)}`, {
      headers: { "user-agent": IPHONE, "x-forwarded-for": "203.0.113.9", cookie: "a=b" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    const ev = events();
    expect(ev[0].ct).toBe("other");
    const line = lines.find((l) => l.startsWith("{"))!;
    expect(line.length).toBeLessThan(200);
    for (const leak of ["ZZZ", "203.0.113.9", "iPhone", "a=b"]) expect(line).not.toContain(leak);
    const body = await res.text();
    expect(body).not.toContain("ZZZ");
    expect(body).toContain('href="/go?ct=other&amp;cta=hero"');
  });

  test("CTA links carry the normalised step and fall back to /go without JS", async () => {
    const body = await (await req("/?ct=email1")).text();
    const hrefs = [...body.matchAll(/<a [^>]*data-cta[^>]*>/g)].map((m) => m[0].match(/href="([^"]+)"/)![1]);
    expect(hrefs).toEqual(["/go?ct=email1&amp;cta=top", "/go?ct=email1&amp;cta=hero", "/go?ct=email1&amp;cta=close"]);
    const none = await (await req("/")).text();
    expect(none).toContain('href="/go?cta=hero"');
    // JS path: swap to the App Store directly and beacon; no third-party hosts, no cookies/storage.
    expect(body).toContain("navigator.sendBeacon(go)");
    expect(body).toContain(JSON.stringify(STORE_HREF));
    for (const bad of ["document.cookie", "localStorage", "sessionStorage", "fingerprint", "<script src"]) expect(body).not.toContain(bad);
  });
});

describe("/go", () => {
  test("GET redirects to the App Store and logs one tap", async () => {
    const res = await req("/go?ct=email4&cta=close");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(STORE);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const ev = events();
    expect(ev.length).toBe(1);
    expect(Object.keys(ev[0]).sort()).toEqual(["ct", "cta", "evt", "level", "message", "ts", "ua", "via"]);
    expect(ev[0]).toMatchObject({ message: "demo_event", evt: "cta", ct: "email4", cta: "close", ua: "mobile", via: "redirect" });
  });

  test("POST (sendBeacon) answers 204 and logs one tap", async () => {
    const res = await req("/go?ct=email1&cta=hero", { method: "POST" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(events()).toMatchObject([{ evt: "cta", ct: "email1", cta: "hero", via: "beacon" }]);
  });

  test("never an open redirect; bad params still land on the App Store", async () => {
    for (const q of ["?to=https://evil.com", "?ct=https://evil.com&cta=//evil.com", `?ct=${"x".repeat(8000)}`, ""]) {
      const res = await req(`/go${q}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(STORE);
    }
    expect(events().map((e) => [e.ct, e.cta])).toEqual([["none", "other"], ["other", "other"], ["other", "other"], ["none", "other"]]);
  });

  test("HEAD redirects without counting; bots are tagged, not dropped", async () => {
    const head = await req("/go?ct=email1", { method: "HEAD" });
    expect(head.status).toBe(302);
    expect(events().length).toBe(0);
    await req("/go?ct=email1", { headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" } });
    expect(events()).toMatchObject([{ ua: "bot" }]);
  });

  test("works on the Railway host too (the /demo page links there)", async () => {
    expect((await req("/go?ct=email1", { headers: { host: RAILWAY } })).status).toBe(302);
  });
});

describe("demo-stats", () => {
  test("parses raw and railway --json (flattened and nested) lines; ignores echoed text; excludes bots", async () => {
    await req("/?ct=email1");
    await req("/?ct=email1", { headers: { "user-agent": MAC } });
    await req("/go?ct=email1&cta=hero", { method: "POST" });
    await req("/?ct=email2");
    await req("/?ct=email2", { headers: { "user-agent": "curl/8" } });
    const raw = lines.filter((l) => l.startsWith("{"));
    const mixed = [
      raw[0]!,
      JSON.stringify({ ...JSON.parse(raw[1]!), timestamp: "2026-10-12T00:00:00Z" }), // railway --json, attributes flattened
      JSON.stringify({ message: raw[2], timestamp: "x", level: "info" }), // event inside message
      raw[3]!,
      raw[4]!,
      `<-- GET /${raw[3]}`, // event-shaped text echoed in an access-log path: ignored
      "--> GET /?ct=email1 200 1ms",
      "not json {",
    ];
    expect(parseEvent(mixed[5]!)).toBeNull();
    expect(parseEvent(mixed[6]!)).toBeNull();
    const { rows, bots } = summarize(mixed);
    expect(rows.email1).toEqual({ views: 2, taps: 1, mobile: 1, desktop: 1 });
    expect(rows.email2).toEqual({ views: 1, taps: 0, mobile: 1, desktop: 0 });
    expect(bots).toBe(1);
    expect(summarize(mixed, { bots: true }).rows.email2!.views).toBe(2);
    expect(summarize(mixed, { since: "2999-01-01" }).total).toBe(0);
  });
});

describe("Apple campaign attribution (STAGEWELL_APPLE_PT)", () => {
  const PT = "123456789";
  const prev = process.env.STAGEWELL_APPLE_PT;
  afterEach(() => {
    if (prev === undefined) delete process.env.STAGEWELL_APPLE_PT;
    else process.env.STAGEWELL_APPLE_PT = prev;
  });
  const ctaTags = (body: string) => [...body.matchAll(/<a [^>]*data-cta[^>]*>/g)].map((m) => m[0]);
  const attr = (tag: string, name: string) => tag.match(new RegExp(` ${name}="([^"]*)"`))![1]!;
  const unesc = (s: string) => s.replace(/&amp;/g, "&");

  test("unset or invalid pt: /go and data-store are exactly the current URL", async () => {
    for (const v of [undefined, "", "  ", "abc", "12a", "-1", "1".repeat(21), "123&ct=x", "123\r\nX-Evil: 1", "https://evil.com"]) {
      if (v === undefined) delete process.env.STAGEWELL_APPLE_PT;
      else process.env.STAGEWELL_APPLE_PT = v;
      expect(applePt()).toBeNull();
      expect(storeHref("email1")).toBe(STORE);
      expect((await req("/go?ct=email1&cta=hero")).headers.get("location")).toBe(STORE);
      const tags = ctaTags(await (await req("/?ct=email2")).text());
      expect(tags.length).toBe(3);
      for (const t of tags) expect(unesc(attr(t, "data-store"))).toBe(STORE);
    }
  });

  test("pt set: /go carries pt, ct=demo_<step>, mt=8 for every known step", async () => {
    process.env.STAGEWELL_APPLE_PT = ` ${PT} `;
    for (const [q, step] of [["email1", "email1"], ["EMAIL4", "email4"], ["", "none"], ["nope", "other"]] as const) {
      const res = await req(`/go?ct=${q}&cta=hero`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${APP_STORE_URL}?pt=${PT}&ct=demo_${step}&mt=8`);
    }
    expect(events().map((e) => e.ct)).toEqual(["email1", "email4", "none", "other"]);
  });

  test("pt set: page CTAs keep the /go href and carry the same App Store URL for the JS swap", async () => {
    process.env.STAGEWELL_APPLE_PT = PT;
    const body = await (await req("/?ct=email3")).text();
    const tags = ctaTags(body);
    expect(tags.map((t) => attr(t, "href"))).toEqual(["/go?ct=email3&amp;cta=top", "/go?ct=email3&amp;cta=hero", "/go?ct=email3&amp;cta=close"]);
    for (const t of tags) {
      expect(attr(t, "data-store")).toBe(`${APP_STORE_URL}?pt=${PT}&amp;ct=demo_email3&amp;mt=8`);
      expect((await req(unesc(attr(t, "href")))).headers.get("location")).toBe(unesc(attr(t, "data-store")));
    }
    expect(body).toContain('a.getAttribute("data-store")');
    const none = ctaTags(await (await req("/demo")).text());
    expect(unesc(attr(none[0]!, "data-store"))).toBe(`${APP_STORE_URL}?pt=${PT}&ct=demo_none&mt=8`);
  });

  test("hostile / oversized ct never leaks into the URL; host is always apps.apple.com", async () => {
    process.env.STAGEWELL_APPLE_PT = PT;
    const hostile = ["https://evil.com", "//evil.com", "email1%0d%0aSet-Cookie:%20x=1", "email1&pt=999", "email1%26mt%3D1", "<script>", "x".repeat(8000), "email5", "email1 email2"];
    for (const h of hostile) {
      const res = await req(`/go?ct=${h}&cta=top`);
      const loc = res.headers.get("location")!;
      expect(new URL(loc).host).toBe("apps.apple.com");
      const want = h === "email1&pt=999" ? "demo_email1" : "demo_other"; // that one is ct=email1 plus a separate pt param
      expect(loc).toBe(`${APP_STORE_URL}?pt=${PT}&ct=${want}&mt=8`);
      expect(res.headers.get("set-cookie")).toBeNull();
      const tags = ctaTags(await (await req(`/?ct=${h}`)).text());
      for (const t of tags) expect(unesc(attr(t, "data-store"))).toBe(loc);
    }
  });

  test("campaign token: sanitised and capped at 40", () => {
    for (const s of ["email1", "email2", "email3", "email4", "none", "other"] as const) {
      expect(campaignToken(s)).toBe(`demo_${s}`);
    }
    const odd = campaignToken(("A&B=c/" + "z".repeat(60)) as never);
    expect(odd).toMatch(/^[a-z0-9_-]{1,40}$/);
    expect(odd.length).toBe(40);
  });
});
