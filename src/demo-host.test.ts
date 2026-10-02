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
    expect(body).toContain("Live demo");
    expect(body).toContain("/demo/img/living-before.jpg");
    expect(body).toContain("/demo/img/living-after.jpg");
  });

  test("demo host keeps ?ct= and still renders", async () => {
    const res = await get("/?ct=email1", { host: DEMO });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Live demo");
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
