#!/usr/bin/env node

"use strict";

const dns = require("node:dns/promises");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DOMAINS_DIR = path.join(ROOT, "domains");
const TXT_RE = /^vc-domain-verify=([^,\s]+),([0-9a-zA-Z_-]+)$/;

function readEntries() {
  const out = [];
  for (const name of fs.readdirSync(DOMAINS_DIR).sort()) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    if (name.startsWith("_meta") || name.startsWith("_example") || name.toLowerCase() === "schema.json") continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(DOMAINS_DIR, name), "utf8"));
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object") out.push({ file: name, entry: parsed });
  }
  return out;
}

function txtValues(entry) {
  const raw = entry.records && entry.records.TXT;
  if (raw === undefined) return [];
  if (typeof raw === "string") return [raw];
  return Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
}

async function liveTxt(name) {
  try {
    const rows = await dns.resolveTxt(name);
    return rows.map((chunks) => chunks.join(""));
  } catch (error) {
    return { error: error.code || error.message };
  }
}

async function main() {
  const entries = readEntries();
  const tokens = [];
  for (const { file, entry } of entries) {
    const zone = String(entry.domain || "").toLowerCase();
    const sub = String(entry.subdomain || "").toLowerCase();
    const ownerName = sub.includes(".") ? sub.slice(sub.indexOf(".") + 1) : sub;
    for (const value of txtValues(entry)) {
      const match = TXT_RE.exec(value.trim());
      if (!match) continue;
      const declaredFor = match[1].toLowerCase();
      const expectedFor = ownerName === "@" || ownerName === "*" ? zone : `${ownerName}.${zone}`;
      tokens.push({
        file,
        owner: entry.owner,
        txtName: sub === "@" ? zone : `${sub}.${zone}`,
        declaredFor,
        expectedFor,
        token: match[2],
        matches: declaredFor === expectedFor,
      });
    }
  }

  const byToken = new Map();
  for (const row of tokens) {
    if (!byToken.has(row.token)) byToken.set(row.token, []);
    byToken.get(row.token).push(row);
  }

  console.log(`vc-domain-verify tokens: ${tokens.length}\n`);
  for (const row of tokens) {
    const live = await liveTxt(row.txtName);
    const liveValue = Array.isArray(live) ? live : [];
    const published = liveValue.some((v) => v.includes(row.token));
    const drift = Array.isArray(live)
      ? liveValue.filter((v) => TXT_RE.test(v.trim()) && !v.includes(row.token))
      : [];
    const flags = [];
    if (!row.matches) flags.push(`token is for ${row.declaredFor}, file claims ${row.expectedFor}`);
    if (byToken.get(row.token).length > 1) flags.push(`same token in ${byToken.get(row.token).length} entries`);
    if (!Array.isArray(live)) flags.push(`live lookup ${live.error}`);
    else if (!published) flags.push("declared token is not in live DNS");
    if (drift.length > 0) flags.push(`live DNS also holds ${drift.length} other token(s)`);
    console.log(`  ${row.txtName}`);
    console.log(`    owner on file : ${row.owner}`);
    console.log(`    token says    : ${row.declaredFor}`);
    console.log(`    published live: ${published ? "yes" : "no"}`);
    console.log(`    verdict       : ${flags.length === 0 ? "consistent" : flags.join("; ")}`);
  }

  const mismatched = tokens.filter((row) => !row.matches);
  console.log(`\n${tokens.length} token(s), ${mismatched.length} minted for a name the file does not claim`);
  if (mismatched.length > 0 && process.argv.includes("--strict")) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
