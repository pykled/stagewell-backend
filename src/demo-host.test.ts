import { describe, expect, test } from "bun:test";
import server, { isDemoHost } from "./index";

const RAILWAY = "stagewell-backend-production.up.railway.app";
const DEMO = "demo.stagewell.app";

function get(path: string, headers: Record<string, string>) {
  return server.fetch(new Request(`http://localhost${path}`, { headers }));
}

describe("isDemoHost", () => {
  test("matches the demo host in any form", () => {
    for (const h of [DEMO, "DEMO.Stagewell.app", `${DEMO}:443`, `${DEMO}.`, `${DEMO}, ${RAILWAY}`]) {
      expect(isDemoHost(h)).toBe(true);
    }
  });
  test("rejects everything else", () => {
    for (const h of [undefined, "", RAILWAY, "stagewell.app", "evil-demo.stagewell.app", `${DEMO}.evil.com`, `${RAILWAY}, ${DEMO}`]) {
      expect(isDemoHost(h)).toBe(false);
    }
  });
});

describe("GET / by host", () => {
  test("demo host serves the demo page", async () => {
    const res = await get("/", { host: DEMO });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Get Stagewell on the App Store");
    expect(body).toContain("https://apps.apple.com/us/app/stagewell/id6757572170");
    expect(body).toContain("/demo/img/living-before.jpg");
    expect(body).toContain("/demo/img/living-after.jpg");
  });

  test("demo host keeps ?ct= and still renders", async () => {
    const res = await get("/?ct=email1", { host: DEMO });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Get Stagewell on the App Store");
  });

  test("x-forwarded-host takes precedence", async () => {
    expect((await get("/", { host: "internal:8080", "x-forwarded-host": DEMO })).status).toBe(200);
    expect((await get("/", { host: DEMO, "x-forwarded-host": RAILWAY })).status).toBe(404);
  });

  test("non-demo hosts are unchanged (404 text)", async () => {
    for (const host of [RAILWAY, "localhost:3000"]) {
      const res = await get("/", { host });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("404 Not Found");
    }
  });

  test("every demo image the page references is served", async () => {
    const body = await (await get("/", { host: DEMO })).text();
    const srcs = [...body.matchAll(/src="(\/demo\/img\/[^"]+)"/g)].map((m) => m[1]!);
    expect(srcs.length).toBe(6);
    for (const src of srcs) {
      const res = await get(src, { host: DEMO });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
    }
  });

  test("every demo image has intrinsic size and alt text (no layout shift, screen-reader friendly)", async () => {
    const body = await (await get("/", { host: DEMO })).text();
    const imgs = [...body.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(imgs.length).toBe(6);
    for (const tag of imgs) {
      expect(tag).toMatch(/\bwidth="\d+"/);
      expect(tag).toMatch(/\bheight="\d+"/);
      expect(tag).toMatch(/\balt="[^"]+"/);
    }
    // Only the first pair loads eagerly; the rest wait until scrolled near.
    expect(imgs.filter((t) => t.includes('loading="eager"')).length).toBe(2);
    expect(imgs.filter((t) => t.includes('loading="lazy"')).length).toBe(4);
  });

  test("self-hosted display font is served, anything else under /demo/fonts is 404", async () => {
    const body = await (await get("/", { host: DEMO })).text();
    const fonts = [...new Set([...body.matchAll(/\/demo\/fonts\/[^")]+/g)].map((m) => m[0]))];
    expect(fonts.length).toBe(2);
    for (const f of fonts) {
      const res = await get(f, { host: DEMO });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
    }
    expect((await get("/demo/fonts/../../package.json", { host: DEMO })).status).toBe(404);
    expect((await get("/demo/fonts/nope.woff2", { host: DEMO })).status).toBe(404);
    expect((await get("/demo/img/bedroom-after.jpg", { host: DEMO })).status).toBe(404);
  });

  test("the page works without JavaScript: before and after both present, slider is a native range", async () => {
    const body = await (await get("/", { host: DEMO })).text();
    expect((body.match(/class="cmp-before"/g) ?? []).length).toBe(3);
    expect((body.match(/class="cmp-after"/g) ?? []).length).toBe(3);
    expect((body.match(/type="range"/g) ?? []).length).toBe(3);
    // No-JS default: CSS falls back to --pos 50%, so the clip shows half before / half after.
    expect(body).toContain("var(--pos, 50%)");
  });

  test("/demo, /l/demo and /health still work on both hosts", async () => {
    for (const host of [DEMO, RAILWAY]) {
      expect((await get("/demo", { host })).status).toBe(200);
      expect((await get("/l/demo", { host })).status).toBe(200);
      expect((await get("/health", { host })).status).toBe(200);
      expect((await get("/privacy", { host })).status).toBe(200);
      expect((await get("/nope", { host })).status).toBe(404);
    }
  });
});
