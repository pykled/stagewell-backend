import { Hono } from "hono";
import { cors } from "hono/cors";
import "./env";
import { revenuecatWebhookRouter } from "./routes/webhook-revenuecat";
import { stageRouter } from "./routes/stage";
import { pagesRouter } from "./routes/pages";
import { logger } from "hono/logger";

const app = new Hono();

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
app.get("/health", (c) => c.json({ status: "ok" }));

// Routes
app.route("/api/webhooks/revenuecat", revenuecatWebhookRouter);
app.route("/api/stage", stageRouter);
app.route("/", pagesRouter); // GET /privacy, GET /terms, GET /contact

const port = Number(process.env.PORT) || 3000;

export default {
  port,
  fetch: app.fetch,
  // Staged photos arrive as multipart; allow generous bodies (Bun default is 128 MB).
  maxRequestBodySize: 32 * 1024 * 1024,
};
