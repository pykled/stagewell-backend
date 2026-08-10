import { z } from "zod";

/**
 * Environment variable schema using Zod
 * This ensures all required environment variables are present and valid
 */
const envSchema = z.object({
  // Server Configuration
  PORT: z.string().optional().default("3000"),
  NODE_ENV: z.string().optional(),
  BACKEND_URL: z.url("BACKEND_URL must be a valid URL").default("http://localhost:3000"),

  // Supabase — used by the webhook handler to write to the DB with service-role privileges.
  // Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Railway environment variables.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // RevenueCat webhook secret — must match the value configured in the RC dashboard
  // under Project Settings → Webhooks → Authorization header.
  // Set as REVENUECAT_WEBHOOK_SECRET in Railway environment variables.
  REVENUECAT_WEBHOOK_SECRET: z.string().optional(),

  // Google OAuth 2.0 — for Gmail integration
  // Create credentials at https://console.cloud.google.com/apis/credentials
  // Add to Railway ENV as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

/**
 * Validate and parse environment variables
 */
function validateEnv() {
  try {
    const parsed = envSchema.parse(process.env);
    console.log("✅ Environment variables validated successfully");
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
