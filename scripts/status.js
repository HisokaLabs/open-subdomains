#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const R = require("./registry.js");

const TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 512 * 1024;
const SOA_TIMEOUT_MS = 10_000;

const JSON_MODE = process.argv.includes("--json");
const STRICT = process.argv.includes("--strict");
const ZONE_ONLY = process.argv.includes("--zones");

function readEntries(policy) {
  return R.loadClaims()
    .map(({ filename, full }) => {
      const name = R.parseClaimFile(filename, policy.zones);
      if (!name) return null;
      try {
        return { sub: name.subdomain, zone: name.zone, body: JSON.parse(fs.readFileSync(full, "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => !R.isAuxiliary(entry.sub))
    .sort((a, b) => R.fqdnOf(a.sub, a.zone).localeCompare(R.fqdnOf(b.sub, b.zone)));
}

function declared(records, type) {
  if (!records || records[type] === undefined) return [];
  return Array.isArray(records[type]) ? records[type] : [records[type]];
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function resolveFqdn(fqdn) {
  const out = { cname: [], a: [] };
  try {
    out.cname = (await dns.resolveCname(fqdn)).map((value) => value.replace(/\.$/, ""));
  } catch {
    out.cname = [];
  }
  try {
    out.a = await dns.resolve4(fqdn);
  } catch {
    out.a = [];
  }
  return out;
}

function fetchOnce(url) {
  return new Promise((resolve) => {
    let settled = false;
    const options = { headers: { "user-agent": "is-a.ceo status check" }, timeout: TIMEOUT_MS };
    const transport = url.startsWith("http:") ? http : https;

    const request = transport.get(url, options, (response) => {
      const hash = crypto.createHash("sha256");
      let body = "";
      let bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_BODY_BYTES) {
          response.destroy();
          return;
        }
        hash.update(chunk);
        body += chunk;
      });

      const finish = () => {
        if (settled) return;
        settled = true;
        const title = (body.match(/<title[^>]*>([^<]*)/i) || [])[1];
        resolve({
          status: response.statusCode,
          location: response.headers.location || null,
          vercelError: response.headers["x-vercel-error"] || null,
          title: title ? title.trim().slice(0, 60) : null,
          digest: response.statusCode === 200 && body.length > 0 ? hash.digest("hex").slice(0, 16) : null,
        });
      };
      response.on("end", finish);
      response.on("close", finish);
    });

    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ status: 0, error: error.code || error.message });
    });
  });
}

async function probe(fqdn) {
  const home = `https://${fqdn}/`;
  const first = await fetchOnce(home);
  if (first.status < 300 || first.status >= 400 || !first.location) return first;

  const next = first.location.startsWith("http") ? first.location : new URL(first.location, home).toString();
  if (!next.startsWith("http:") && !next.startsWith("https:")) {
    return { ...first, note: "redirect to a non-HTTP scheme not followed" };
  }
  // Following a cross-host redirect would attribute someone else's bytes to
  // this name, which is exactly what the collision check looks for.
  if (hostOf(next) !== hostOf(home)) {
    return { ...first, note: `redirect to ${hostOf(next) || "an unparseable URL"} not followed` };
  }
  return fetchOnce(next);
}

function verdict(entry, live, result) {
  if (!entry.body.records) return "no records, GitHub Pages fallback";
  if (live.cname.length === 0 && live.a.length === 0) return "DNS does not resolve";
  if (result.status === 0) return "TLS or connection failed";
  if (result.vercelError === "DEPLOYMENT_NOT_FOUND") return "Vercel project has no production deployment";
  if (result.status >= 400) return `HTTP ${result.status}`;
  if (result.note) return result.note;
  return "ok";
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("ETIMEOUT")), ms).unref()),
  ]);
}

async function checkZones(zones) {
  const rows = [];
  for (const zone of zones) {
    try {
      const answers = await withTimeout(dns.resolveSoa(zone), SOA_TIMEOUT_MS);
      rows.push({ zone, ok: true, detail: `SOA ${answers.nsname} (serial ${answers.serial})` });
    } catch (error) {
      rows.push({ zone, ok: false, detail: error.code || error.message });
    }
  }
  return rows;
}

async function main() {
  const policy = R.loadPolicy();
  const zones = policy.zones;

  if (ZONE_ONLY) {
    const rows = await checkZones(zones);
    if (JSON_MODE) {
      process.stdout.write(`${JSON.stringify({ checked: new Date().toISOString(), rows }, null, 2)}\n`);
    } else {
      for (const row of rows) {
        process.stdout.write(`${row.ok ? "ok  " : "down"}  ${row.zone}  ${row.detail}\n`);
      }
    }
    if (rows.some((row) => !row.ok) && STRICT) process.exitCode = 1;
    return;
  }

  const entries = readEntries(policy);
  const rows = [];

  for (const entry of entries) {
    const fqdn = R.fqdnOf(entry.sub, entry.zone);
    const live = await resolveFqdn(fqdn);
    const result = live.a.length > 0 || live.cname.length > 0 ? await probe(fqdn) : { status: 0, error: "no address" };
    rows.push({
      name: fqdn,
      owner: R.ownerLabel(entry.body),
      declared: {
        cname: declared(entry.body.records, "CNAME").map((value) => String(value).replace(/\.$/, "")),
        a: declared(entry.body.records, "A"),
      },
      live,
      probe: result,
      verdict: verdict(entry, live, result),
    });
  }

  const byDigest = new Map();
  for (const row of rows) {
    if (!row.probe.digest) continue;
    if (!byDigest.has(row.probe.digest)) byDigest.set(row.probe.digest, []);
    byDigest.get(row.probe.digest).push(row.name);
  }
  const collisions = [...byDigest]
    .filter(([, names]) => names.length > 1)
    .map(([digest, names]) => ({ digest, names }));

  for (const row of rows) {
    const shared = collisions.find((group) => group.names.includes(row.name));
    if (shared) row.verdict = `serves identical bytes as ${shared.names.filter((name) => name !== row.name).join(", ")}`;
  }

  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ zones, checked: new Date().toISOString(), collisions, rows }, null, 2)}\n`);
    if (collisions.length > 0 && STRICT) process.exitCode = 1;
    return;
  }

  if (rows.length === 0) {
    process.stdout.write("no entries to probe\n");
    return;
  }

  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows) {
    const code = String(row.probe.status || 0).padStart(3);
    const targets = row.declared.cname.length ? row.declared.cname.join(",") : row.declared.a.join(",");
    process.stdout.write(
      `${row.name.padEnd(width)}  ${code}  ${row.owner.padEnd(14)}  ${row.verdict}\n` +
        `${" ".repeat(width)}        targets ${targets || "none"}\n`,
    );
  }
  if (collisions.length > 0) {
    process.stdout.write(`\n${collisions.length} content collision(s):\n`);
    for (const group of collisions) process.stdout.write(`  ${group.names.join(" = ")}  (${group.digest})\n`);
    if (STRICT) process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`status: ${error.message}\n`);
  process.exitCode = 1;
});
