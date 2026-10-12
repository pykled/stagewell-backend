#!/usr/bin/env bun
/**
 * Read-only: count demo-page views and App Store CTA taps per email step from
 * the `demo_event` JSON lines (src/routes/demo-events.ts) in Railway logs.
 *
 *   RAILWAY_API_TOKEN=... railway logs --json --since 7d --filter demo_event | bun scripts/demo-stats.ts
 *   bun scripts/demo-stats.ts saved-logs.txt [--since 2026-10-12] [--bots]
 *
 * Accepts raw event lines or `railway logs --json` objects (fields flattened
 * or the event JSON inside `message`); use --json, plain `railway logs` text is
 * ignored.
 * Bot/scanner traffic is excluded unless --bots is given (its count is shown).
 * Railway only returns logs for one deployment at a time (the latest by
 * default); pass a DEPLOYMENT_ID to `railway logs` to read older ones.
 */
import { readFileSync } from "node:fs";
import type { DemoEvent } from "../src/routes/demo-events";

const STEPS = ["email1", "email2", "email3", "email4", "none", "other"] as const;

// Whole-line JSON only: a request path can echo event-shaped text into the
// plain-text access log, so substrings of other lines are never trusted.
export function parseEvent(line: string): DemoEvent | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  let o: any;
  try { o = JSON.parse(t); } catch { return null; }
  if (o && typeof o.message === "string" && o.message.startsWith("{")) {
    try { const inner = JSON.parse(o.message); if (inner?.evt) o = inner; } catch {}
  }
  if (o && (o.evt === "view" || o.evt === "cta") && typeof o.ct === "string" && typeof o.ts === "string") return o as DemoEvent;
  return null;
}

export interface StepRow { views: number; taps: number; mobile: number; desktop: number }

export function summarize(lines: string[], opts: { since?: string; bots?: boolean } = {}) {
  const rows: Record<string, StepRow> = {};
  for (const s of STEPS) rows[s] = { views: 0, taps: 0, mobile: 0, desktop: 0 };
  let bots = 0;
  let total = 0;
  for (const line of lines) {
    const e = parseEvent(line);
    if (!e) continue;
    if (opts.since && e.ts < opts.since) continue;
    if (e.ua === "bot") { bots++; if (!opts.bots) continue; }
    const r = rows[e.ct] ?? rows.other!;
    total++;
    if (e.evt === "view") {
      r.views++;
      if (e.ua === "mobile") r.mobile++;
      else if (e.ua === "desktop") r.desktop++;
    } else r.taps++;
  }
  return { rows, bots, total };
}

if (import.meta.main) {
  let since: string | undefined;
  let bots = false;
  const files: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since") since = args[++i];
    else if (args[i] === "--bots") bots = true;
    else files.push(args[i]!);
  }
  const text = files.length ? files.map((f) => readFileSync(f, "utf8")).join("\n") : readFileSync(0, "utf8");
  const { rows, bots: botCount } = summarize(text.split("\n"), { since, bots });

  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
  console.log(`step     views  taps  tap/view  mobile  desktop${since ? `   (since ${since})` : ""}`);
  let v = 0, t = 0;
  for (const s of STEPS) {
    const r = rows[s]!;
    v += r.views; t += r.taps;
    console.log(`${s.padEnd(8)} ${String(r.views).padStart(5)} ${String(r.taps).padStart(5)} ${pct(r.taps, r.views).padStart(9)} ${String(r.mobile).padStart(7)} ${String(r.desktop).padStart(8)}`);
  }
  console.log(`${"total".padEnd(8)} ${String(v).padStart(5)} ${String(t).padStart(5)} ${pct(t, v).padStart(9)}`);
  console.log(bots ? `bot/scanner events included: ${botCount}` : `bot/scanner events excluded: ${botCount} (--bots to include)`);
}
