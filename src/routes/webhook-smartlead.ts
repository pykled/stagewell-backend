/**
 * Smartlead reply webhook: POST /api/smartlead/reply
 *
 * Smartlead calls this on EMAIL_REPLY. We log the reply to `smartlead_replies`
 * and ping #stagewell so someone answers the agent within the hour.
 *
 * Always returns 200 once the request is accepted: Smartlead retries non-2xx
 * responses, and a Discord or DB hiccup must not turn into duplicate pings.
 *
 * Optional shared secret: when SMARTLEAD_WEBHOOK_SECRET is set, the webhook URL
 * configured in Smartlead must carry `?secret=<value>`; anything else gets 401.
 *
 * Discord delivery: DISCORD_WEBHOOK_URL (preferred) or DISCORD_BOT_TOKEN posting
 * to DISCORD_STAGEWELL_CHANNEL_ID. With neither set the reply is still logged.
 */
import { Hono } from "hono";
import { getSupabaseAdmin } from "../lib/supabase-admin";
import { env } from "../env";

type Json = Record<string, unknown>;

// Keep the whole handler well under Smartlead's webhook timeout so a slow Discord never causes a retry (= duplicate ping).
const DISCORD_TIMEOUT_MS = 5000;

export interface SmartleadReply {
  senderName: string | null;
  senderEmail: string | null;
  replyBody: string;
  campaignName: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drop the quoted thread ("On Mon, X wrote:" and "> " lines) so the preview shows what they actually said. */
function stripQuoted(text: string): string {
  const cut = text.search(/\n\s*(On .{0,200}wrote:|-{2,}\s*Original Message|From: .+\n)/i);
  const head = cut > 0 ? text.slice(0, cut) : text;
  return head
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

/**
 * Smartlead's payload shape varies by event version, so every field is read
 * from several known locations. The lead (the agent who replied) is the sender.
 */
export function parseSmartleadReply(body: Json): SmartleadReply {
  const lead = obj(body.lead_data ?? body.lead);
  const reply = obj(body.reply_message);

  const senderEmail =
    str(body.sl_lead_email) ??
    str(body.lead_email) ??
    str(lead.email) ??
    str(reply.from) ??
    str(body.from_email);

  const first = str(lead.first_name) ?? str(body.lead_first_name);
  const last = str(lead.last_name) ?? str(body.lead_last_name);
  const senderName =
    str(body.lead_name) ??
    str(lead.name) ??
    ([first, last].filter(Boolean).join(" ") || null) ??
    str(body.from_name);

  const rawText =
    str(reply.text) ??
    (str(reply.html) ? htmlToText(reply.html as string) : null) ??
    str(body.reply_body) ??
    str(body.preview_text) ??
    (str(body.reply_html) ? htmlToText(body.reply_html as string) : null) ??
    "";

  return {
    senderName,
    senderEmail,
    replyBody: stripQuoted(rawText) || rawText,
    campaignName: str(body.campaign_name) ?? str(obj(body.campaign).name),
  };
}

export function discordMessage(r: SmartleadReply): string {
  const who = r.senderName ?? r.senderEmail ?? "unknown sender";
  const preview = r.replyBody.length > 300 ? `${r.replyBody.slice(0, 300)}…` : r.replyBody;
  const quoted = (preview || "(empty reply)")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return [
    `⚡ Reply received from **${who}** — respond within 1 hour`,
    `**Agent:** ${r.senderName ?? "—"} (${r.senderEmail ?? "no email"})`,
    r.campaignName ? `**Campaign:** ${r.campaignName}` : null,
    quoted,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1900);
}

async function postToDiscord(content: string): Promise<void> {
  // Reply text is attacker-controlled; never let it ping @everyone or roles.
  const payload = { content, allowed_mentions: { parse: [] as string[] } };
  let res: Response;
  if (env.DISCORD_WEBHOOK_URL) {
    res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
  } else if (env.DISCORD_BOT_TOKEN) {
    res = await fetch(`https://discord.com/api/v10/channels/${env.DISCORD_STAGEWELL_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
  } else {
    console.warn("[Smartlead] no DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN set; skipping Discord ping");
    return;
  }
  if (!res.ok) {
    console.error(`[Smartlead] Discord post failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

const smartleadRouter = new Hono();

smartleadRouter.post("/reply", async (c) => {
  if (env.SMARTLEAD_WEBHOOK_SECRET && c.req.query("secret") !== env.SMARTLEAD_WEBHOOK_SECRET) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Json = {};
  try {
    body = obj(await c.req.json());
  } catch {
    console.warn("[Smartlead] reply webhook with non-JSON body");
  }

  const eventType = str(body.event_type);
  if (eventType && eventType !== "EMAIL_REPLY") {
    return c.json({ ok: true, ignored: eventType });
  }

  const reply = parseSmartleadReply(body);
  if (!reply.senderEmail && !reply.replyBody) {
    console.warn("[Smartlead] reply webhook with no sender or body; ignored");
    return c.json({ ok: true, ignored: "empty" });
  }
  console.log(`[Smartlead] reply from ${reply.senderEmail ?? "?"} (${reply.campaignName ?? "no campaign"})`);

  const admin = getSupabaseAdmin();
  const logRow = admin
    ? admin
        .from("smartlead_replies")
        .insert({
          sender_name: reply.senderName,
          sender_email: reply.senderEmail,
          reply_body: reply.replyBody,
          campaign_name: reply.campaignName,
          payload: body,
        })
        .then(({ error }) => {
          if (error) console.error(`[Smartlead] smartlead_replies insert failed: ${error.message}`);
        })
    : Promise.resolve(console.warn("[Smartlead] Supabase not configured; reply not logged"));

  await Promise.allSettled([
    logRow,
    postToDiscord(discordMessage(reply)).catch((e) => console.error(`[Smartlead] Discord post threw: ${e}`)),
  ]);

  return c.json({ ok: true });
});

export { smartleadRouter };
