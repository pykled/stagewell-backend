/**
 * Server-side canonical image storage for staged rooms.
 *
 * After a successful generation, POST /api/stage writes BOTH images to the
 * private `stagewell` bucket with the service role and records them in the
 * legacy `images` table (one row per variant, keyed `{imageId}_{variant}`) so
 * every installed build can list, restore and delete them. This is what makes
 * a room survive the phone: the bytes are in the cloud before the client ever
 * sees the response.
 *
 * Layout (proposal §2.3):
 *   {userId}/images/{imageId}/before.jpg      source photo as sent to Gemini   → images row `{imageId}_original`
 *   {userId}/images/{imageId}/after.{png|jpg} Gemini output, NEVER watermarked → images row `{imageId}_full`
 *
 * The legacy client layout `{userId}/{listingId|null}/{imageId}/{thumb,full,original}.jpg`
 * is untouched; rows point at whichever path holds the bytes.
 *
 * No thumbnail is produced here (no image codec in the Bun runtime; see
 * proposal §5.2 for the open decision). Clients treat `full` as the display
 * source, so nothing depends on the `thumb` row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env";

export type Admin = SupabaseClient;

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export interface ImageBytes {
  buf: Buffer;
  mimeType: ImageMime;
}

export interface PersistInput {
  userId: string;
  imageId: string;
  listingId: string | null;
  roomType: string;
  style: string;
  before: ImageBytes;
  after: ImageBytes;
}

export type PersistResult =
  | { status: "ready"; beforePath: string; afterPath: string; listingId: string | null; bytes: number }
  | { status: "pending_upload"; error: string; listingId: string | null };

export interface StoredImage {
  imageId: string;
  base64: string;
  mimeType: string;
  beforePath: string | null;
  afterPath: string;
  listingId: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function extFor(mime: ImageMime): string {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

/** `{userId}/images/{imageId}/{before|after}.{ext}` */
export function imageObjectPath(userId: string, imageId: string, kind: "before" | "after", mime: ImageMime): string {
  return `${userId}/images/${imageId}/${kind}.${extFor(mime)}`;
}

/** Row ids in the legacy `images` table are `{imageId}_{variant}`. */
export function imageRowId(imageId: string, variant: "full" | "original" | "thumb"): string {
  return `${imageId}_${variant}`;
}

function bucket() {
  return env.STAGE_OUTPUT_BUCKET;
}

async function uploadObject(admin: Admin, path: string, bytes: ImageBytes): Promise<string | null> {
  const { error } = await admin.storage
    .from(bucket())
    .upload(path, bytes.buf, { contentType: bytes.mimeType, upsert: true });
  return error ? error.message : null;
}

async function removeObjects(admin: Admin, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await admin.storage.from(bucket()).remove(paths);
  if (error) console.warn(`[Storage] could not remove ${paths.join(", ")}: ${error.message}`);
}

/**
 * Make sure a `listings` row exists for a client-chosen listing UUID and that it
 * belongs to this user. Returns the listing id to store on the image rows, or
 * null when the listing cannot be used (someone else's id, DB error).
 *
 * Title/colour are only written when the row does not exist yet; the client is
 * the editing surface for listing metadata and keeps it in sync itself.
 */
export async function ensureListingRow(
  admin: Admin,
  userId: string,
  listingId: string,
  title: string | undefined,
  color: string | undefined,
): Promise<string | null> {
  const { data: existing, error: readErr } = await admin
    .from("listings")
    .select("id,user_id")
    .eq("id", listingId)
    .maybeSingle();
  if (readErr) {
    console.error(`[Storage] listing read failed ${listingId}: ${readErr.message}`);
    return null;
  }
  if (existing) {
    if ((existing as { user_id: string }).user_id !== userId) {
      console.warn(`[Storage] listing ${listingId} belongs to another user; storing image unassigned`);
      return null;
    }
    return listingId;
  }
  const { error: insErr } = await admin.from("listings").insert({
    id: listingId,
    user_id: userId,
    title: (title ?? "").trim() || "Untitled Listing",
    color: (color ?? "").trim() || "#0F2A44",
  });
  if (insErr) {
    // A concurrent insert from the client (ensureListing) is fine.
    if (insErr.code === "23505") return listingId;
    console.error(`[Storage] listing insert failed ${listingId}: ${insErr.message}`);
    return null;
  }
  return listingId;
}

/**
 * Write before + after to storage and upsert the two `images` rows.
 * Never throws: a failure is reported as `pending_upload` so the route can still
 * hand the generated image to the client, which then falls back to its own
 * upload queue for this one image.
 */
export async function persistStagedImage(admin: Admin, input: PersistInput): Promise<PersistResult> {
  // The image id is client-chosen and the upsert runs with the service role:
  // never let one user's request rewrite rows that belong to another user.
  const { data: owned, error: ownErr } = await admin
    .from("images")
    .select("id,user_id")
    .in("id", [imageRowId(input.imageId, "full"), imageRowId(input.imageId, "original"), imageRowId(input.imageId, "thumb")]);
  if (ownErr) {
    const error = `ownership check failed: ${ownErr.message}`;
    console.error(`[Storage] ${error} (user=${input.userId} image=${input.imageId})`);
    return { status: "pending_upload", error, listingId: input.listingId };
  }
  if ((owned ?? []).some((r) => (r as { user_id: string }).user_id !== input.userId)) {
    const error = "image id belongs to another user";
    console.warn(`[Storage] ${error} (user=${input.userId} image=${input.imageId})`);
    return { status: "pending_upload", error, listingId: input.listingId };
  }

  const beforePath = imageObjectPath(input.userId, input.imageId, "before", input.before.mimeType);
  const afterPath = imageObjectPath(input.userId, input.imageId, "after", input.after.mimeType);

  const [beforeErr, afterErr] = await Promise.all([
    uploadObject(admin, beforePath, input.before),
    uploadObject(admin, afterPath, input.after),
  ]);
  if (beforeErr || afterErr) {
    const error = `storage upload failed: ${beforeErr ?? afterErr}`;
    console.error(`[Storage] ${error} (user=${input.userId} image=${input.imageId})`);
    await removeObjects(admin, [beforePath, afterPath]);
    return { status: "pending_upload", error, listingId: input.listingId };
  }

  const rows = [
    {
      id: imageRowId(input.imageId, "original"),
      user_id: input.userId,
      listing_id: input.listingId,
      storage_path: beforePath,
      variant: "original",
      bytes: input.before.buf.length,
      room_type: input.roomType,
      style: input.style,
      // Server-written rows never carry a retention expiry: the server is the
      // canonical copy and silent expiry is the one thing the product must not do.
      expires_at: null,
      sync_status: "synced",
      pending_delete: false,
      deleted_at: null,
    },
    {
      id: imageRowId(input.imageId, "full"),
      user_id: input.userId,
      listing_id: input.listingId,
      storage_path: afterPath,
      variant: "full",
      bytes: input.after.buf.length,
      room_type: input.roomType,
      style: input.style,
      expires_at: null,
      sync_status: "synced",
      pending_delete: false,
      deleted_at: null,
    },
  ];

  let { error: rowErr } = await admin.from("images").upsert(rows, { onConflict: "id" });

  // A dangling listing id (row deleted between ensureListingRow and here) must
  // not lose the image: retry unassigned.
  if (rowErr && rowErr.code === "23503" && input.listingId) {
    console.warn(`[Storage] listing ${input.listingId} vanished; storing image ${input.imageId} unassigned`);
    const retry = await admin
      .from("images")
      .upsert(rows.map((r) => ({ ...r, listing_id: null })), { onConflict: "id" });
    rowErr = retry.error;
    if (!rowErr) input = { ...input, listingId: null };
  }

  if (rowErr) {
    const error = `images upsert failed: ${rowErr.message}`;
    console.error(`[Storage] ${error} (user=${input.userId} image=${input.imageId})`);
    await removeObjects(admin, [beforePath, afterPath]);
    return { status: "pending_upload", error, listingId: input.listingId };
  }

  return {
    status: "ready",
    beforePath,
    afterPath,
    listingId: input.listingId,
    bytes: input.before.buf.length + input.after.buf.length,
  };
}

/**
 * Load a previously persisted generation for replay, by image id.
 * Returns null when there is no `{imageId}_full` row for this user or the
 * object cannot be downloaded.
 */
export async function loadStoredImage(admin: Admin, userId: string, imageId: string): Promise<StoredImage | null> {
  const { data, error } = await admin
    .from("images")
    .select("id,variant,storage_path,listing_id,pending_delete")
    .eq("user_id", userId)
    .in("id", [imageRowId(imageId, "full"), imageRowId(imageId, "original")]);
  if (error || !data || data.length === 0) return null;

  type Row = { id: string; variant: string; storage_path: string; listing_id: string | null; pending_delete: boolean };
  const rows = data as Row[];
  const full = rows.find((r) => r.variant === "full");
  if (!full || full.pending_delete) return null;
  const original = rows.find((r) => r.variant === "original") ?? null;

  const { data: blob, error: dlErr } = await admin.storage.from(bucket()).download(full.storage_path);
  if (dlErr || !blob) return null;
  const buf = Buffer.from(await blob.arrayBuffer());
  if (buf.length === 0) return null;

  return {
    imageId,
    base64: buf.toString("base64"),
    mimeType: blob.type || (full.storage_path.endsWith(".png") ? "image/png" : "image/jpeg"),
    beforePath: original?.storage_path ?? null,
    afterPath: full.storage_path,
    listingId: full.listing_id,
  };
}

/** Image id recorded on the `generations` row for a request, if any. */
export async function findImageIdForRequest(admin: Admin, userId: string, requestId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("generations")
    .select("image_id")
    .eq("user_id", userId)
    .eq("request_id", requestId)
    .maybeSingle();
  if (error || !data) return null;
  const id = (data as { image_id?: string | null }).image_id ?? null;
  return isUuid(id) ? id : null;
}
