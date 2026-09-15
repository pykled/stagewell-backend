/**
 * Server-side Gemini image generation.
 *
 * The API key lives only in the backend environment (GEMINI_API_KEY). The
 * mobile app never talks to Google directly.
 */
import { env } from "../env";

export const ROOM_TYPES = [
  "living-room",
  "bedroom",
  "kitchen",
  "dining-room",
  "bathroom",
  "office",
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const STYLES = [
  "modern",
  "minimalist",
  "traditional",
  "coastal",
  "industrial",
  "scandinavian",
] as const;
export type RoomStyle = (typeof STYLES)[number];

export type ImageSize = "1K" | "2K";

const ROOM_LABELS: Record<RoomType, string> = {
  "living-room": "Living Room",
  bedroom: "Bedroom",
  kitchen: "Kitchen",
  "dining-room": "Dining Room",
  bathroom: "Bathroom",
  office: "Office",
};

const STYLE_LABELS: Record<RoomStyle, string> = {
  modern: "Modern",
  minimalist: "Minimalist",
  traditional: "Traditional",
  coastal: "Coastal",
  industrial: "Industrial",
  scandinavian: "Scandinavian",
};

const FURNITURE_BY_ROOM: Record<RoomType, string> = {
  bedroom:
    "Queen/king bed with stylish bedding centered against the main wall, two nightstands with elegant table lamps, a decorative headboard, tasteful wall art above the bed, a cozy throw blanket",
  "living-room":
    "Comfortable sofa with accent pillows, coffee table with decorative items, accent chair, floor lamp, gallery wall or large statement art piece, floating shelves with curated decor",
  kitchen:
    "Bar stools at counter/island, pendant lights over island, small potted herbs, decorative cutting boards, stylish containers on counter, open shelving with ceramics",
  "dining-room":
    "Dining table with 4-6 chairs, statement chandelier or pendant light, wall art or large mirror, sideboard or buffet with decor, table centerpiece with candles or flowers",
  bathroom:
    "Plush towels on towel bars, decorative mirror with frame, small plant, bath mat, candles, stylish soap dispensers, wall-mounted art or prints",
  office:
    "Modern desk with ergonomic chair, desk lamp, bookshelf with books and decor, wall art or motivational prints, floating shelves, desk accessories",
};

const PRESERVE_BLOCK = `CRITICAL - PRESERVE THE ROOM STRUCTURE EXACTLY:
- Keep the EXACT same walls, wall color, wall texture, and paint
- Keep the EXACT same flooring (hardwood, carpet, tile, etc.)
- Keep the EXACT same windows, window frames, and natural lighting direction
- Keep the EXACT same doors, door frames, and trim/molding
- Keep the EXACT same ceiling, ceiling height, and any ceiling features
- Keep the EXACT same room dimensions, angles, and camera perspective
- Keep the EXACT same architectural details (built-ins, fireplaces, alcoves, counters, cabinets)
- Keep any permanent fixtures (light fixtures, ceiling fans, built-in shelving)
- Do NOT change the room structure, layout, or dimensions in any way`;

/**
 * Build the staging prompt. Ported verbatim from the former client-side
 * generatePrompt() so output quality does not change with the move to the proxy.
 */
export function buildStagingPrompt(
  roomType: RoomType,
  style: RoomStyle,
  options: { declutterOnly?: boolean } = {},
): string {
  const roomLabel = ROOM_LABELS[roomType].toLowerCase();
  const styleLabel = STYLE_LABELS[style].toLowerCase();

  if (options.declutterOnly) {
    return `You are a professional virtual stager for real estate photography. Edit this ${roomLabel} image to REMOVE all furniture, decor, rugs, clutter and personal items so the room appears completely empty and clean.

${PRESERVE_BLOCK}

REMOVE EVERYTHING MOVABLE:
- Remove all furniture, rugs, curtains that are not built-in, wall art, plants, appliances that are not built-in, and personal items
- Fill in the floor and walls behind removed items realistically, matching the existing materials, colors and lighting
- Keep the room's natural light, shadows and perspective consistent

QUALITY REQUIREMENTS:
- Photorealistic result that looks like a real photograph of the empty room, not CGI
- No artifacts, ghosting or leftover outlines where objects were removed

The final image should look like an actual photograph of the same ${roomLabel}, completely empty and ready to be staged.`;
  }

  const furniture = FURNITURE_BY_ROOM[roomType];

  return `You are a professional virtual stager for real estate photography. Edit this ${roomLabel} image to add virtual staging.

${PRESERVE_BLOCK}

HANDLING EXISTING FURNITURE:
- If the room already has furniture, mentally remove ALL existing furniture first
- Strip the room to its empty architectural state (walls, floors, windows, doors, built-ins only)
- Then virtually stage with new furniture as if starting with an empty room
- Do NOT blend old and new furniture - replace everything with cohesive new staging
- The result should look like the room was emptied and then professionally staged

ADD NEW STAGING (${styleLabel} style):
${furniture}
- Area rug to anchor the furniture grouping (if appropriate for the space)
- Potted plants (floor and/or tabletop)
- Coordinated accent pieces and accessories
- Ensure furniture placement makes sense for the room's layout and traffic flow

QUALITY REQUIREMENTS:
- Furniture must have realistic shadows and lighting matching the room's natural light source
- Proper scale - furniture sized appropriately for the room dimensions
- Photorealistic rendering that looks like a real photograph, not CGI
- Magazine-quality real estate photography result
- Consistent lighting throughout - new furniture should match existing light conditions

The final image should look like an actual photograph of a beautifully staged ${roomLabel} that was professionally photographed, not a digital rendering or composite.`;
}

export type GeminiErrorCode =
  | "not_configured"
  | "timeout"
  | "rate_limited"
  | "blocked"
  | "no_image"
  | "upstream_error";

export class GeminiError extends Error {
  code: GeminiErrorCode;
  status: number | undefined;
  retryable: boolean;
  constructor(code: GeminiErrorCode, message: string, status?: number, retryable = false) {
    super(message);
    this.name = "GeminiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface GeminiImageResult {
  imageBase64: string;
  mimeType: string;
  model: string;
  latencyMs: number;
  /** Whether the request was sent with imageConfig.imageSize. */
  sizeRequested: ImageSize;
}

interface GeminiResponse {
  error?: { code?: number; message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
  }>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call Gemini to stage one image.
 *
 * - Timeout per attempt (GEMINI_TIMEOUT_MS, default 90 s)
 * - One retry on 429 / 5xx / timeout
 * - If the model rejects `imageConfig` (older model / preview change), retries once
 *   without it so a config drift never takes staging down.
 */
export async function generateStagedImage(params: {
  imageBase64: string;
  mimeType: string;
  prompt: string;
  size: ImageSize;
  /** Absolute epoch ms by which the whole call (all attempts) must finish. */
  deadlineAt?: number;
}): Promise<GeminiImageResult> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError("not_configured", "GEMINI_API_KEY is not set");
  }

  const model = env.GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const perAttemptMs = Number(env.GEMINI_TIMEOUT_MS);
  const deadlineAt = params.deadlineAt ?? Date.now() + Number(env.STAGE_TOTAL_DEADLINE_MS);
  /** Minimum time worth starting another attempt with. */
  const MIN_ATTEMPT_MS = 15_000;

  const remaining = () => deadlineAt - Date.now();
  const canRetry = (attempt: number) => attempt < 2 && remaining() > MIN_ATTEMPT_MS;

  const makeBody = (withImageConfig: boolean) =>
    JSON.stringify({
      contents: [
        {
          parts: [
            { text: params.prompt },
            { inlineData: { mimeType: params.mimeType, data: params.imageBase64 } },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(withImageConfig && params.size !== "1K"
          ? { imageConfig: { imageSize: params.size } }
          : {}),
      },
    });

  let withImageConfig = true;
  let lastError: GeminiError | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now();
    const attemptMs = Math.min(perAttemptMs, remaining());
    if (attemptMs <= 0) {
      throw lastError ?? new GeminiError("timeout", "Staging deadline exceeded before Gemini could be called", undefined, false);
    }

    // The abort scope covers BOTH the headers and the body read: image
    // responses are multi-MB JSON and a stalled body is the realistic hang.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);

    let data: GeminiResponse;
    let status: number;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: makeBody(withImageConfig),
        signal: controller.signal,
      });
      status = res.status;
      try {
        data = (await res.json()) as GeminiResponse;
      } catch (err) {
        if (controller.signal.aborted) throw err; // handled below as a timeout
        lastError = new GeminiError("upstream_error", `Gemini returned non-JSON (${res.status})`, res.status, res.status >= 500);
        if (lastError.retryable && canRetry(attempt)) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw lastError;
      }
    } catch (err) {
      if (err instanceof GeminiError) throw err;
      const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      lastError = new GeminiError(
        aborted ? "timeout" : "upstream_error",
        aborted ? `Gemini timed out after ${attemptMs} ms` : `Gemini request failed: ${String(err)}`,
        undefined,
        true,
      );
      if (canRetry(attempt)) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
    const res = { ok: status >= 200 && status < 300, status };

    if (!res.ok || data.error) {
      const msg = data.error?.message ?? `HTTP ${res.status}`;
      const status = data.error?.code ?? res.status;

      // Model rejected imageConfig → retry once without it.
      if (withImageConfig && status === 400 && /image_?config|image_?size/i.test(msg)) {
        console.warn(`[Gemini] imageConfig rejected by ${model}; retrying without it: ${msg}`);
        withImageConfig = false;
        continue;
      }

      const retryable = status === 429 || status >= 500;
      lastError = new GeminiError(
        status === 429 ? "rate_limited" : "upstream_error",
        msg,
        status,
        retryable,
      );
      if (retryable && canRetry(attempt)) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    if (data.promptFeedback?.blockReason) {
      throw new GeminiError("blocked", `Blocked by safety filter: ${data.promptFeedback.blockReason}`, 422);
    }

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const imagePart = parts.find((p) => p.inlineData?.data);

    if (!imagePart?.inlineData) {
      const reason = candidate?.finishReason;
      if (reason && /SAFETY|PROHIBITED|BLOCK/i.test(reason)) {
        throw new GeminiError("blocked", `Generation blocked (${reason})`, 422);
      }
      throw new GeminiError("no_image", `No image in Gemini response (finishReason=${reason ?? "unknown"})`, 502);
    }

    return {
      imageBase64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || "image/png",
      model,
      latencyMs: Date.now() - started,
      sizeRequested: withImageConfig ? params.size : "1K",
    };
  }

  throw lastError ?? new GeminiError("upstream_error", "Gemini request failed");
}
