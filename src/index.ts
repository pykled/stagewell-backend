import { Hono } from "hono";
import { cors } from "hono/cors";
import "./env";
import { sampleRouter } from "./routes/sample";
import { revenuecatWebhookRouter } from "./routes/webhook-revenuecat";
import { logger } from "hono/logger";

const app = new Hono();

// CORS middleware - validates origin against allowlist
app.use(
  "*",
  cors({
    origin: ['http://localhost:8081', 'http://localhost:19006', 'https://stagewell-api.railway.app'],
    credentials: true,
  })
);

// Logging
app.use("*", logger());

// Health check endpoint
app.get("/health", (c) => c.json({ status: "ok" }));

// Routes
app.route("/api/sample", sampleRouter);
app.route("/api/webhooks/revenuecat", revenuecatWebhookRouter);

const port = Number(process.env.PORT) || 3000;

export default {
  port,
  fetch: app.fetch,
};
