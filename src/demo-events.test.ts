import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import server from "./index";
import { classifyUa, normalizeCt, normalizeCta, STORE_HREF } from "./routes/demo-events";
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
