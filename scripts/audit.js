#!/usr/bin/env node

"use strict";

const dns = require("node:dns/promises");
const fs = require("node:fs");

const R = require("./registry.js");

function txtValues(body) {
  const raw = body.records && body.records.TXT;
  if (raw === undefined) return [];
  if (typeof raw === "string") return [raw];
  return Array.isArray(raw) ? raw.filter((value) => typeof value === "string") : [];
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
  const policy = R.loadPolicy();
  const tokens = [];

  for (const { filename, full } of R.loadClaims()) {
    const name = R.parseClaimFile(filename, policy.zones);
    if (!name) continue;
    let body;
    try {
      body = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    // _vercel.holder answers on a name of its own, and the proof inside it names
    // the claim it belongs to. That base name is what has to match.
    const base = name.subdomain.startsWith("_vercel.") ? name.subdomain.slice("_vercel.".length) : name.subdomain;

    for (const value of txtValues(body)) {
      const match = R.VERIFY_RE.exec(value.trim());
      if (!match) continue;
      tokens.push({
        file: filename,
        owner: R.ownerLabel(body),
        txtName: R.fqdnOf(name.subdomain, name.zone),
        declaredFor: match[1].toLowerCase(),
        expectedFor: R.fqdnOf(base, name.zone),
        token: match[2],
      });
    }
  }

  const byToken = new Map();
  for (const row of tokens) {
    if (!byToken.has(row.token)) byToken.set(row.token, []);
    byToken.get(row.token).push(row);
  }

  console.log(`vc-domain-verify tokens: ${tokens.length}\n`);

  let mismatched = 0;
  for (const row of tokens) {
    const live = await liveTxt(row.txtName);
    const published = Array.isArray(live) && live.some((value) => value.includes(row.token));
    const drift = Array.isArray(live) ? live.filter((value) => R.VERIFY_RE.test(value.trim()) && !value.includes(row.token)) : [];

    const flags = [];
    if (row.declaredFor !== row.expectedFor) {
      flags.push(`token is for ${row.declaredFor}, the file belongs to ${row.expectedFor}`);
      mismatched += 1;
    }
    if (byToken.get(row.token).length > 1) flags.push(`the same token sits in ${byToken.get(row.token).length} entries`);
    if (!Array.isArray(live)) flags.push(`live lookup ${live.error}`);
    else if (!published) flags.push("declared token is not in live DNS");
    if (drift.length > 0) flags.push(`live DNS also holds ${drift.length} other token(s)`);

    console.log(`  ${row.txtName}`);
    console.log(`    owner on file : ${row.owner}`);
    console.log(`    token says    : ${row.declaredFor}`);
    console.log(`    published live: ${published ? "yes" : "no"}`);
    console.log(`    verdict       : ${flags.length === 0 ? "consistent" : flags.join("; ")}`);
  }

  console.log(`\n${tokens.length} token(s), ${mismatched} minted for a name the file does not claim`);
  if (mismatched > 0 && process.argv.includes("--strict")) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`audit: ${error.message}\n`);
  process.exitCode = 1;
});
