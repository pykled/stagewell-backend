/**
 * Public, shareable listing page: GET /l/:listingId
 *
 * Server-rendered HTML (no auth, no React) showing every staged room in a
 * listing as a before/after slider. The listing UUID is the share secret:
 * anyone with the link can view the photos, nobody can enumerate listings.
 *
 * Photos live in the private `stagewell` bucket, so the page never embeds
 * storage URLs directly. It points at GET /l/:listingId/img/:imageId/:kind,
 * which checks the image belongs to the listing and 302s to a short-lived
 * signed URL. That keeps og:image stable for link previews while signed URLs
 * keep expiring.
 *
 * Data model (see lib/storage.ts): `images` rows are keyed `{imageId}_{variant}`.
 * The `full` row is the staged result and usually carries `original_path`;
 * legacy client uploads instead have a separate `{imageId}_original` row.
 */
import { Hono } from "hono";
import { getSupabaseAdmin } from "../lib/supabase-admin";
import { isUuid } from "../lib/storage";
import { env } from "../env";

const SIGNED_URL_TTL_S = 60 * 60;
const IMAGE_ID_RE = /^[A-Za-z0-9-]{1,100}$/;

interface Room {
  imageId: string;
  roomType: string;
  style: string;
  hasBefore: boolean;
}

interface ImageRow {
  id: string;
  variant: "thumb" | "full" | "original";
  storage_path: string;
  original_path: string | null;
  room_type: string;
  style: string;
  created_at: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function imageIdOf(rowId: string): string {
  return rowId.replace(/_(full|original|thumb)$/, "");
}

function label(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

async function loadRows(listingId: string): Promise<ImageRow[] | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from("images")
    .select("id,variant,storage_path,original_path,room_type,style,created_at")
    .eq("listing_id", listingId)
    .eq("pending_delete", false)
    .is("deleted_at", null)
    .in("variant", ["full", "original"])
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`[ListingPage] images read failed ${listingId}: ${error.message}`);
    return null;
  }
  return (data ?? []) as ImageRow[];
}

function roomsFrom(rows: ImageRow[]): Room[] {
  const originals = new Set(rows.filter((r) => r.variant === "original").map((r) => imageIdOf(r.id)));
  return rows
    .filter((r) => r.variant === "full")
    .map((r) => {
      const imageId = imageIdOf(r.id);
      return {
        imageId,
        roomType: r.room_type,
        style: r.style,
        hasBefore: Boolean(r.original_path) || originals.has(imageId),
      };
    });
}

function shell(opts: { title: string; description: string; url: string; ogImage?: string; body: string }): string {
  const { title, description, url, ogImage, body } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Stagewell">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(ogImage)}">` : `<meta name="twitter:card" content="summary">`}
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="robots" content="noindex">
<style>
  :root { color-scheme: dark; --bg: #0B0B10; --card: #15151D; --line: #262633; --text: #F5F5F7; --muted: #9A9AAE; --accent: #8B5CF6; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; line-height: 1.5; -webkit-font-smoothing: antialiased; }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 16px 64px; }
  header { margin-bottom: 28px; }
  .brand { color: var(--accent); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; }
  h1 { font-size: clamp(24px, 4vw, 36px); margin: 6px 0 4px; line-height: 1.15; }
  .sub { color: var(--muted); margin: 0; font-size: 15px; }
  .rooms { display: grid; gap: 28px; }
  figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; }
  figcaption { padding: 12px 16px; font-size: 14px; color: var(--muted); display: flex; justify-content: space-between; gap: 12px; }
  figcaption b { color: var(--text); font-weight: 600; }
  .ba { position: relative; aspect-ratio: 4 / 3; background: #000; overflow: hidden; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
  .ba img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  .ba .before { clip-path: inset(0 calc(100% - var(--pos, 50%)) 0 0); }
  .ba .handle { position: absolute; top: 0; bottom: 0; left: var(--pos, 50%); width: 2px; margin-left: -1px; background: #fff; box-shadow: 0 0 12px rgba(0,0,0,.5); pointer-events: none; }
  .ba .handle::after { content: "‹ ›"; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 40px; height: 40px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 16px; font-weight: 700; display: grid; place-items: center; letter-spacing: 2px; box-shadow: 0 2px 10px rgba(0,0,0,.4); }
  .ba .tag { position: absolute; top: 12px; padding: 3px 10px; border-radius: 999px; background: rgba(0,0,0,.6); font-size: 12px; font-weight: 600; letter-spacing: .04em; pointer-events: none; }
  .ba .tag.l { left: 12px; } .ba .tag.r { right: 12px; background: var(--accent); }
  .ba input[type=range] { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: ew-resize; }
  .solo { display: block; width: 100%; height: auto; }
  .empty { padding: 48px 16px; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 16px; }
  footer { margin-top: 40px; color: var(--muted); font-size: 13px; text-align: center; }
  footer a { color: var(--accent); text-decoration: none; }
  .demo-badge { display: inline-block; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 3px 10px; border-radius: 999px; margin-bottom: 10px; }
  .cta-block { margin-top: 40px; text-align: center; padding: 32px 20px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; }
  .cta-block p { color: var(--muted); font-size: 16px; margin: 0 0 16px; }
  .cta-btn { display: inline-block; background: var(--accent); color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 12px; font-size: 16px; font-weight: 600; letter-spacing: .01em; }
  .cta-btn:hover { opacity: .9; }
</style>
</head>
<body>
<main>
${body}
<footer>Virtually staged with <a href="https://stagewell.app">Stagewell</a></footer>
</main>
<script>
  document.querySelectorAll(".ba input[type=range]").forEach(function (r) {
    var box = r.parentElement;
    function set() { box.style.setProperty("--pos", r.value + "%"); }
    r.addEventListener("input", set);
    set();
  });
</script>
</body>
</html>`;
}

function notFound(): string {
  return shell({
    title: "Listing not found · Stagewell",
    description: "This listing does not exist or is no longer shared.",
    url: env.BACKEND_URL,
    body: `<header><div class="brand">Stagewell</div><h1>Listing not found</h1><p class="sub">This link may have expired or the listing was removed.</p></header>`,
  });
}

interface DemoImagePair {
  roomType: string;
  style: string;
  afterPath: string;
  beforePath: string;
}

async function loadDemoPairs(): Promise<DemoImagePair[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];
  const { data, error } = await admin
    .from("images")
    .select("id,storage_path,original_path,room_type,style")
    .eq("variant", "full")
    .not("original_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error || !data?.length) return [];
  const seen = new Set<string>();
  const pairs: DemoImagePair[] = [];
  for (const row of data as { id: string; storage_path: string; original_path: string; room_type: string; style: string }[]) {
    if (!seen.has(row.room_type) && pairs.length < 3) {
      seen.add(row.room_type);
      pairs.push({ roomType: row.room_type, style: row.style, afterPath: row.storage_path, beforePath: row.original_path });
    }
  }
  return pairs;
}

async function renderDemoPage(base: string): Promise<string> {
  const pairs = await loadDemoPairs();
  const admin = getSupabaseAdmin();
  let figures = "";
  if (admin && pairs.length) {
    const paths = pairs.flatMap((p) => [p.afterPath, p.beforePath]);
    const { data: signed } = await admin.storage.from(env.STAGE_OUTPUT_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_S);
    const urlMap = new Map((signed ?? []).map((item) => [item.path, item.signedUrl]));
    figures = pairs
      .map((p, i) => {
        const afterUrl = urlMap.get(p.afterPath);
        const beforeUrl = urlMap.get(p.beforePath);
        if (!afterUrl || !beforeUrl) return "";
        const alt = `${label(p.roomType)} staged in ${label(p.style)} style`;
        const caption = `<figcaption><b>${esc(label(p.roomType))}</b><span>${esc(label(p.style))}</span></figcaption>`;
        return `<figure>
  <div class="ba">
    <img src="${esc(afterUrl)}" alt="${esc(alt)}" loading="${i ? "lazy" : "eager"}">
    <img class="before" src="${esc(beforeUrl)}" alt="${esc(label(p.roomType))} before staging" loading="${i ? "lazy" : "eager"}">
    <span class="tag l">BEFORE</span><span class="tag r">AFTER</span>
    <div class="handle"></div>
    <input type="range" min="0" max="100" value="50" aria-label="Drag to compare before and after">
  </div>
  ${caption}
</figure>`;
      })
      .filter(Boolean)
      .join("\n");
  }

  const body = `<header>
  <div class="demo-badge">Live demo</div>
  <div class="brand">Stagewell</div>
  <h1>See what AI virtual staging looks like</h1>
  <p class="sub">Real photos staged with Stagewell — drag to compare before and after</p>
</header>
${figures ? `<div class="rooms">${figures}</div>` : `<div class="empty">Demo images are loading — check back in a moment.</div>`}
<div class="cta-block">
  <p>Stage your own listings in minutes</p>
  <a class="cta-btn" href="https://apps.apple.com/app/stagewell/id6739063294">Download Stagewell — Free</a>
</div>`;

  return shell({
    title: "Virtual Staging Demo · Stagewell",
    description: "See AI virtual staging in action. Real before-and-after photos from Stagewell — drag the slider to compare.",
    url: `${base}/demo`,
    body,
  });
}

const listingPageRouter = new Hono();

listingPageRouter.get("/demo", async (c) => {
  const base = new URL(c.req.url).origin.replace(/^http:\/\/(?!localhost)/, "https://");
  c.header("Cache-Control", "public, max-age=300");
  return c.html(await renderDemoPage(base));
});

listingPageRouter.get("/:listingId", async (c) => {
  const listingId = c.req.param("listingId").toLowerCase();
  const base = new URL(c.req.url).origin.replace(/^http:\/\/(?!localhost)/, "https://");
  if (!isUuid(listingId)) return c.html(await renderDemoPage(base), 200);

  const admin = getSupabaseAdmin();
  if (!admin) return c.html(notFound(), 503);

  const { data: listing, error } = await admin
    .from("listings")
    .select("id,title,is_archived")
    .eq("id", listingId)
    .maybeSingle();
  if (error) {
    console.error(`[ListingPage] listing read failed ${listingId}: ${error.message}`);
    return c.html(notFound(), 503);
  }
  if (!listing) return c.html(await renderDemoPage(base), 200);

  const rows = await loadRows(listingId);
  if (rows === null) return c.html(notFound(), 503);
  const rooms = roomsFrom(rows);

  const pageUrl = `${base}/l/${listingId}`;
  const img = (r: Room, kind: "before" | "after") => `/l/${listingId}/img/${encodeURIComponent(r.imageId)}/${kind}`;
  const title = (listing.title as string)?.trim() || "Staged listing";
  const count = rooms.length;

  const figures = rooms
    .map((r, i) => {
      const caption = `<figcaption><b>${esc(label(r.roomType))}</b><span>${esc(label(r.style))}</span></figcaption>`;
      const alt = `${label(r.roomType)} staged in ${label(r.style)} style`;
      if (!r.hasBefore) {
        return `<figure><img class="solo" src="${img(r, "after")}" alt="${esc(alt)}" loading="${i ? "lazy" : "eager"}">${caption}</figure>`;
      }
      return `<figure>
  <div class="ba">
    <img src="${img(r, "after")}" alt="${esc(alt)}" loading="${i ? "lazy" : "eager"}">
    <img class="before" src="${img(r, "before")}" alt="${esc(label(r.roomType))} before staging" loading="${i ? "lazy" : "eager"}">
    <span class="tag l">BEFORE</span><span class="tag r">AFTER</span>
    <div class="handle"></div>
    <input type="range" min="0" max="100" value="50" aria-label="Drag to compare before and after">
  </div>
  ${caption}
</figure>`;
    })
    .join("\n");

  const body = `<header>
  <div class="brand">Stagewell</div>
  <h1>${esc(title)}</h1>
  <p class="sub">${count === 0 ? "No staged rooms yet" : `${count} staged room${count === 1 ? "" : "s"}${rooms.some((r) => r.hasBefore) ? " · drag to compare before and after" : ""}`}</p>
</header>
${count === 0 ? `<div class="empty">Staged photos for this listing will appear here.</div>` : `<div class="rooms">${figures}</div>`}`;

  c.header("Cache-Control", "public, max-age=300");
  return c.html(
    shell({
      title: `${title} · Virtually staged`,
      description: count ? `See ${count} virtually staged room${count === 1 ? "" : "s"} for ${title}.` : `Virtually staged photos for ${title}.`,
      url: pageUrl,
      ogImage: rooms[0] ? `${base}${img(rooms[0], "after")}` : undefined,
      body,
    }),
  );
});

listingPageRouter.get("/:listingId/img/:imageId/:kind", async (c) => {
  const listingId = c.req.param("listingId").toLowerCase();
  const imageId = c.req.param("imageId");
  const kind = c.req.param("kind");
  if (!isUuid(listingId) || !IMAGE_ID_RE.test(imageId) || (kind !== "before" && kind !== "after")) {
    return c.text("Not found", 404);
  }
  const admin = getSupabaseAdmin();
  if (!admin) return c.text("Unavailable", 503);

  const { data, error } = await admin
    .from("images")
    .select("id,variant,storage_path,original_path")
    .in("id", [`${imageId}_full`, `${imageId}_original`])
    .eq("listing_id", listingId)
    .eq("pending_delete", false)
    .is("deleted_at", null);
  if (error) {
    console.error(`[ListingPage] image read failed ${imageId}: ${error.message}`);
    return c.text("Unavailable", 503);
  }
  const rows = (data ?? []) as Pick<ImageRow, "id" | "variant" | "storage_path" | "original_path">[];
  const full = rows.find((r) => r.variant === "full");
  const original = rows.find((r) => r.variant === "original");
  const path = kind === "after" ? full?.storage_path : full?.original_path ?? original?.storage_path;
  if (!path) return c.text("Not found", 404);

  const { data: signed, error: signErr } = await admin.storage
    .from(env.STAGE_OUTPUT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_S);
  if (signErr || !signed?.signedUrl) {
    console.error(`[ListingPage] sign failed ${path}: ${signErr?.message}`);
    return c.text("Not found", 404);
  }
  // Shorter than the signed URL's lifetime so a cached redirect never points at an expired URL.
  c.header("Cache-Control", "public, max-age=1800");
  return c.redirect(signed.signedUrl, 302);
});

export { listingPageRouter, renderDemoPage };
