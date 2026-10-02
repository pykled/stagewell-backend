import { Hono } from "hono";
import { cors } from "hono/cors";
import "./env";
import { revenuecatWebhookRouter } from "./routes/webhook-revenuecat";
import { stageRouter } from "./routes/stage";
import { pagesRouter } from "./routes/pages";
import { listingPageRouter, renderDemoPage, serveDemoImage } from "./routes/listing-page";
import { smartleadRouter } from "./routes/webhook-smartlead";
import { logger } from "hono/logger";

const app = new Hono();

const DEMO_HOSTS = new Set(["demo.stagewell.app"]);

/** First hop of a (possibly comma-joined) host header, lowercased, port and trailing dot stripped. */
export function isDemoHost(raw: string | undefined): boolean {
  if (!raw) return false;
  const host = (raw.split(",")[0] ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return DEMO_HOSTS.has(host);
}

// CORS middleware - validates origin against allowlist
app.use(
  "*",
  cors({
    origin: [
      'http://localhost:8081',
      'http://localhost:19006',
      'https://stagewell-backend-production.up.railway.app',
      'https://stagewell-api.railway.app'
    ],
    credentials: true,
  })
);

// Logging
app.use("*", logger());

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok", build: "listing-page+smartlead+demo" }));

// Routes
app.route("/api/webhooks/revenuecat", revenuecatWebhookRouter);
app.route("/api/stage", stageRouter);
app.route("/api/smartlead", smartleadRouter); // POST /api/smartlead/reply
app.get("/demo", async (c) => {
  const base = new URL(c.req.url).origin.replace(/^http:\/\/(?!localhost)/, "https://");
  c.header("Cache-Control", "public, max-age=300");
  return c.html(renderDemoPage(base));
});
// Bare demo host: https://demo.stagewell.app/ (cold-email CTA) serves the demo at the root.
// Every other host falls through, so `/` stays a 404 there exactly as before.
app.get("/", async (c, next) => {
  if (!isDemoHost(c.req.header("x-forwarded-host") ?? c.req.header("host"))) return next();
  const base = new URL(c.req.url).origin.replace(/^http:\/\/(?!localhost)/, "https://");
  c.header("Cache-Control", "public, max-age=300");
  return c.html(renderDemoPage(base));
});
app.get("/demo/img/:file", (c) => serveDemoImage(c.req.param("file")));
app.route("/l", listingPageRouter); // GET /l/:listingId — public shareable listing page
app.route("/", pagesRouter); // GET /privacy, GET /terms, GET /contact

const port = Number(process.env.PORT) || 3000;

export default {
  port,
  fetch: app.fetch,
  // Staged photos arrive as multipart; allow generous bodies (Bun default is 128 MB).
  maxRequestBodySize: 32 * 1024 * 1024,
};
