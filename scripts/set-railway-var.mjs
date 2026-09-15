#!/usr/bin/env node
/**
 * Upsert one Railway environment variable WITHOUT the value ever appearing on a
 * command line, in shell history, or in logs.
 *
 * The value is read from a local dotenv-style file (default: ../app/.env) or
 * from stdin. Auth uses the token the Railway CLI already stored in
 * ~/.railway/config.json. Project / environment / service ids default to the
 * stagewell-backend production service.
 *
 * Usage:
 *   node scripts/set-railway-var.mjs --name GEMINI_API_KEY --from-file ../app/.env --from-key EXPO_PUBLIC_GOOGLE_API_KEY
 *   printf '%s' "$VALUE" | node scripts/set-railway-var.mjs --name GEMINI_API_KEY --stdin
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const has = (flag) => args.includes(flag);

const name = opt("--name");
if (!name) {
  console.error("Missing --name");
  process.exit(2);
}

const projectId = opt("--project", "8896ea38-479e-4a0d-8330-62e540b76306");
const environmentId = opt("--environment", "e2defc9d-b0ae-4833-90fd-4067e9d9a980");
const serviceId = opt("--service", "aacb2716-d51e-4d9d-91ac-5db2ec40690a");

let value;
if (has("--stdin")) {
  value = readFileSync(0, "utf8").replace(/\r?\n$/, "");
} else if (has("--from-json")) {
  // Read build.production.env.<key> from an eas.json-shaped file.
  const file = opt("--from-json");
  const key = opt("--from-key", name);
  const json = JSON.parse(readFileSync(file, "utf8"));
  value = json?.build?.production?.env?.[key] ?? json?.[key];
  if (typeof value !== "string") {
    console.error(`Key ${key} not found in ${file}`);
    process.exit(2);
  }
} else {
  const file = opt("--from-file", "../app/.env");
  const key = opt("--from-key", name);
  const text = readFileSync(file, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) {
    console.error(`Key ${key} not found in ${file}`);
    process.exit(2);
  }
  value = line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}
if (!value) {
  console.error("Empty value; refusing to set");
  process.exit(2);
}

const cfg = JSON.parse(readFileSync(join(homedir(), ".railway", "config.json"), "utf8"));
const token = cfg?.user?.token;
if (!token) {
  console.error("No Railway CLI token found in ~/.railway/config.json (run `railway login`)");
  process.exit(2);
}

const res = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    query: `mutation Upsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
    variables: { input: { projectId, environmentId, serviceId, name, value } },
  }),
});
const body = await res.json();
if (!res.ok || body.errors) {
  console.error("Railway API error:", JSON.stringify(body.errors ?? body));
  process.exit(1);
}
console.log(`✅ ${name} set on Railway (${value.length} chars, value not shown)`);
