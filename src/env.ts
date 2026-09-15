import { z } from "zod";

/**
 * Environment variable schema using Zod
 * This ensures all required environment variables are present and valid.
 *
 * Tuning variables use `.catch(default)` so a typo in Railway can never take
 * the whole service (and the RevenueCat webhook) down.
 */
const envSchema = z.object({
  // Server Configuration
  PORT: z.string().optional().default("3000"),
  NODE_ENV: z.string().optional(),
  BACKEND_URL: z.url("BACKEND_URL must be a valid URL").default("http://localhost:3000"),

  // Supabase — service-role access for the webhook handler and the staging proxy.
  // Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Railway environment variables.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // RevenueCat webhook secret — must match the value configured in the RC dashboard
  // under Project Settings → Webhooks → Authorization header.
  REVENUECAT_WEBHOOK_SECRET: z.string().optional(),

  // Google Gemini — server-side image generation for POST /api/stage.
  // The key must never be shipped in the app bundle again.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).catch("gemini-3.1-flash-image-preview"),
  /** Per-attempt timeout (headers + body). */
  GEMINI_TIMEOUT_MS: z.string().regex(/^\d+$/).catch("90000"),
  /** Overall budget across retries; must stay below the app's 150 s client timeout. */
  STAGE_TOTAL_DEADLINE_MS: z.string().regex(/^\d+$/).catch("130000"),
  /** Output size requested for paid plans ("1K" | "2K"). Free is always 1K. */
  GEMINI_PAID_IMAGE_SIZE: z.enum(["1K", "2K"]).catch("2K"),

  // Staging proxy rate limits (per user)
  STAGE_RATE_LIMIT_PER_HOUR: z.string().regex(/^\d+$/).catch("60"),
  STAGE_MAX_INFLIGHT_PER_USER: z.string().regex(/^\d+$/).catch("5"),
  /** Bucket where finished generations are kept so a replayed request_id can be served without regenerating. */
  STAGE_OUTPUT_BUCKET: z.string().min(1).catch("stagewell"),
});

/**
 * Validate and parse environment variables
 */
function validateEnv() {
  try {
    const parsed = envSchema.parse(process.env);
    console.log("✅ Environment variables validated successfully");

    if (parsed.NODE_ENV === "production") {
      const missing = (["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "REVENUECAT_WEBHOOK_SECRET", "GEMINI_API_KEY"] as const)
        .filter((k) => !parsed[k]);
      if (missing.length > 0) {
        // Loud warning rather than exit: a missing key must not take the whole
        // service (and the RevenueCat webhook) down. Affected routes return 503.
        console.error(`⚠️  Missing production env vars: ${missing.join(", ")}`);
      }
    }
    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("❌ Environment variable validation failed:");
      error.issues.forEach((err: any) => {
        console.error(`  - ${err.path.join(".")}: ${err.message}`);
      });
      console.error("\nPlease check your .env file and ensure all required variables are set.");
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Validated and typed environment variables
 */
export const env = validateEnv();

/**
 * Type of the validated environment variables
 */
export type Env = z.infer<typeof envSchema>;

/**
 * Extend process.env with our environment variables
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    // eslint-disable-next-line import/namespace
    interface ProcessEnv extends z.infer<typeof envSchema> {}
  }
}
