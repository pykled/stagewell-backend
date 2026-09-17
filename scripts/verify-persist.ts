/**
 * Integration check for the server-canonical image write (src/lib/storage.ts).
 *
 * 1. Boots the API with real Supabase credentials (fetched in-process from the
 *    Management API with the PAT in the OpenClaw credentials file; never
 *    printed) and checks /api/stage rejects unauthenticated calls.
 * 2. Runs persistStagedImage() for a real user with two tiny JPEGs + a listing,
 *    verifies rows + objects + replay lookup, then deletes everything it wrote.
 *
 * Usage (from backend/):  bun run scripts/verify-persist.ts <user-uuid>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const PROJECT_REF = "gkhpqkgzukfgssegzljg";
const userId = process.argv[2];
if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
  console.error("usage: bun run scripts/verify-persist.ts <user-uuid>");
  process.exit(2);
}

function pat(): string {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const text = readFileSync(join(homedir(), ".openclaw/workspace/memory/shared/credentials.md"), "utf8");
  const m = text.match(/sbp_[A-Za-z0-9]+/);
  if (!m) throw new Error("PAT not found");
  return m[0];
}

async function serviceRoleKey(): Promise<string> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${pat()}` },
  });
  if (!res.ok) throw new Error(`api-keys ${res.status}`);
  const keys = (await res.json()) as { name: string; api_key: string }[];
  const key = keys.find((k) => k.name === "service_role")?.api_key;
  if (!key) throw new Error("service_role key not in response");
  return key;
}

const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;
const key = await serviceRoleKey();
process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = key;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "unused-for-this-check";
process.env.PORT = "39991";

// ── 1. Route smoke test under Bun ─────────────────────────────────────────────
const BASE = "http://127.0.0.1:39991"; // explicit IPv4: Bun.serve binds v4, `localhost` may resolve to ::1
const server = Bun.spawn(["bun", "run", "src/index.ts"], {
  env: { ...process.env },
  stdout: "pipe",
  stderr: "pipe",
});
process.on("exit", () => server.kill());
let ok = false;
for (let i = 0; i < 40 && !ok; i++) {
  await Bun.sleep(250);
  try {
    ok = (await fetch(`${BASE}/health`)).ok;
  } catch {
    /* not up yet */
  }
}
if (!ok) {
  server.kill();
  const out = await new Response(server.stdout).text();
  const err = await new Response(server.stderr).text();
  console.error("server stdout:\n" + out.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>"));
  console.error("server stderr:\n" + err.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>"));
  throw new Error("server did not start");
}
const noAuth = await fetch(`${BASE}/api/stage`, { method: "POST" });
const badAuth = await fetch(`${BASE}/api/stage`, { method: "POST", headers: { Authorization: "Bearer nope" } });
console.log(`route: no token → ${noAuth.status} (expect 401); bad token → ${badAuth.status} (expect 401)`);
server.kill();
if (noAuth.status !== 401 || badAuth.status !== 401) throw new Error("route auth gate failed");

// ── 2. persistStagedImage round trip ──────────────────────────────────────────
const { persistStagedImage, loadStoredImage, ensureListingRow, imageRowId } = await import("../src/lib/storage");
const admin = createClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });

// Smallest valid JPEG (1×1) so the sniffers and content-type paths are real.
const tinyJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
const imageId = crypto.randomUUID();
const listingId = crypto.randomUUID();
const wrote: { rows: string[]; objects: string[]; listing: string | null } = { rows: [], objects: [], listing: null };

try {
  const ensured = await ensureListingRow(admin, userId, listingId, "verify-persist listing", "#123456");
  if (ensured !== listingId) throw new Error(`ensureListingRow returned ${ensured}`);
  wrote.listing = listingId;

  const result = await persistStagedImage(admin, {
    userId,
    imageId,
    listingId,
    roomType: "living-room",
    style: "modern",
    before: { buf: tinyJpeg, mimeType: "image/jpeg" },
    after: { buf: tinyJpeg, mimeType: "image/jpeg" },
  });
  console.log("persist:", JSON.stringify(result));
  if (result.status !== "ready") throw new Error("persist failed");
  wrote.objects.push(result.beforePath, result.afterPath);
  wrote.rows.push(imageRowId(imageId, "original"), imageRowId(imageId, "full"));

  const { data: rows } = await admin.from("images").select("id,variant,storage_path,listing_id,bytes,expires_at").in("id", wrote.rows);
  console.log("rows:", JSON.stringify(rows));
  if (!rows || rows.length !== 2) throw new Error("expected 2 rows");
  if (rows.some((r: { listing_id: string | null }) => r.listing_id !== listingId)) throw new Error("listing_id not set");
  if (rows.some((r: { expires_at: string | null }) => r.expires_at !== null)) throw new Error("expires_at should be null");

  const { data: objs } = await admin.storage.from("stagewell").list(`${userId}/images/${imageId}`);
  console.log("objects:", (objs ?? []).map((o) => o.name).join(", "));
  if (!objs || objs.length !== 2) throw new Error("expected 2 objects");

  const replay = await loadStoredImage(admin, userId, imageId);
  if (!replay || replay.afterPath !== result.afterPath || replay.listingId !== listingId) throw new Error("replay lookup failed");
  console.log(`replay: ${replay.base64.length} b64 chars, mime=${replay.mimeType}, before=${replay.beforePath}`);

  // Listing-vanished path: FK → SET NULL must keep the rows.
  await admin.from("listings").delete().eq("id", listingId);
  wrote.listing = null;
  const { data: after } = await admin.from("images").select("id,listing_id").in("id", wrote.rows);
  if (!after || after.length !== 2 || after.some((r: { listing_id: string | null }) => r.listing_id !== null)) {
    throw new Error("FK SET NULL did not keep rows / null listing");
  }
  console.log("listing delete → rows kept with listing_id=null ✓");

  // queue_image_deletion as service role: tombstone + queue rows
  const { data: q, error: qErr } = await admin.rpc("queue_image_deletion", { p_image_id: imageId });
  if (qErr) throw new Error(`queue_image_deletion: ${qErr.message}`);
  console.log("queue_image_deletion:", JSON.stringify(q));
  const { data: tomb } = await admin.from("images").select("id,pending_delete").in("id", wrote.rows);
  if (!tomb || tomb.some((r: { pending_delete: boolean }) => !r.pending_delete)) throw new Error("tombstone not set");
  const { data: psd } = await admin.from("pending_storage_deletions").select("object_path,status").in("object_path", wrote.objects);
  console.log("pending_storage_deletions:", JSON.stringify(psd));
  if (!psd || psd.length !== 2) throw new Error("expected 2 queue rows");
  console.log("ALL CHECKS PASSED");
} finally {
  // Clean up everything this script created (hard delete: test data only)
  await admin.from("pending_storage_deletions").delete().in("object_path", wrote.objects);
  await admin.from("images").delete().in("id", wrote.rows);
  if (wrote.objects.length) await admin.storage.from("stagewell").remove(wrote.objects);
  if (wrote.listing) await admin.from("listings").delete().eq("id", wrote.listing);
  await admin.from("generations").delete().eq("image_id", imageId);
  const { data: left } = await admin.from("images").select("id").in("id", wrote.rows);
  const { data: leftObj } = await admin.storage.from("stagewell").list(`${userId}/images/${imageId}`);
  console.log(`cleanup: rows left=${left?.length ?? 0} objects left=${leftObj?.length ?? 0}`);
}
