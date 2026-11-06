"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;

const DOMAINS_DIR = path.join(__dirname, "..", "domains");
const TIMEOUT_MS = 12000;
const MAX_BODY_BYTES = 512 * 1024;

function readEntries() {
  return fs
    .readdirSync(DOMAINS_DIR)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !["_meta.json", "_example.json", "SCHEMA.json"].includes(name))
    .filter((name) => !path.basename(name, ".json").startsWith("_"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(DOMAINS_DIR, name), "utf8")))
    .sort((a, b) => `${a.subdomain}.${a.domain}`.localeCompare(`${b.subdomain}.${b.domain}`));
}

function flatten(records, type) {
  if (!records) return [];
  const value = records[type];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function resolveFqdn(fqdn) {
  const out = {};
  try {
    out.cname = (await dns.resolveCname(fqdn)).map((v) => v.replace(/\.$/, ""));
  } catch (error) {
    out.cname = [];
  }
  try {
    out.a = await dns.resolve4(fqdn);
  } catch (error) {
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
      let head = "";
      let bytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes <= MAX_BODY_BYTES) {
          hash.update(chunk);
          if (head.length < 20000) head += chunk;
          body += chunk;
          return;
        }
        response.destroy();
      });
      const finish = () => {
        if (settled) return;
        settled = true;
        const title = (body.match(/<title[^>]*>([^<]*)/i) || [])[1];
        const digest = response.statusCode === 200 && body.length > 0 ? hash.digest("hex").slice(0, 16) : null;
        resolve({
          status: response.statusCode,
          location: response.headers.location || null,
          vercelError: response.headers["x-vercel-error"] || null,
          etag: response.headers.etag || null,
          title: title ? title.trim().slice(0, 60) : null,
          digest,
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
  const first = await fetchOnce(`https://${fqdn}/`);
  if (first.status >= 300 && first.status < 400 && first.location) {
    const next = first.location.startsWith("http")
      ? first.location
      : new URL(first.location, `https://${fqdn}/`).toString();
    if (hostOf(next) !== hostOf(`https://${fqdn}/`)) {
      return { ...first, note: `redirect to ${hostOf(next) || "an unparseable URL"} not followed` };
    }
    if (!next.startsWith("https:") && !next.startsWith("http:")) {
      return { ...first, note: "redirect to a non-HTTP scheme not followed" };
    }
    return fetchOnce(next);
  }
  return first;
}

function verdict(entry, live, probeResult) {
  if (!entry.records) return "no records, GitHub Pages fallback";
  if (live.cname.length === 0 && live.a.length === 0) return "DNS does not resolve";
  if (probeResult.status === 0) return "TLS or connection failed";
  if (probeResult.vercelError === "DEPLOYMENT_NOT_FOUND") return "Vercel project has no production deployment";
  if (probeResult.status >= 400) return `HTTP ${probeResult.status}`;
  if (probeResult.note) return probeResult.note;
  return "ok";
}

async function main() {
  const meta = JSON.parse(fs.readFileSync(path.join(DOMAINS_DIR, "_meta.json"), "utf8"))._meta;
  const zones = Array.isArray(meta.zones) ? meta.zones.map((z) => String(z).toLowerCase()) : [];
  const entries = readEntries();
  const rows = [];
  for (const entry of entries) {
    const zone = String(entry.domain || zones[0] || "").toLowerCase();
    const fqdn = entry.subdomain === "@" ? zone : `${entry.subdomain}.${zone}`;
    const live = await resolveFqdn(fqdn);
    const probeResult = live.a.length > 0 ? await probe(fqdn) : { status: 0, error: "no address" };
    rows.push({
      name: fqdn,
      owner: entry.owner,
      declared: {
        cname: flatten(entry.records, "CNAME").map((v) => String(v).replace(/\.$/, "")),
        a: flatten(entry.records, "A"),
      },
      live,
      probe: probeResult,
      verdict: verdict(entry, live, probeResult),
    });
  }
  const collisions = [];
  const byDigest = new Map();
  for (const row of rows) {
    if (!row.probe.digest) continue;
    if (!byDigest.has(row.probe.digest)) byDigest.set(row.probe.digest, []);
    byDigest.get(row.probe.digest).push(row.name);
  }
  for (const [digest, names] of byDigest) {
    if (names.length > 1) collisions.push({ digest, names });
  }
  for (const row of rows) {
    const shared = collisions.find((group) => group.names.includes(row.name));
    if (shared) row.verdict = `serves identical bytes as ${shared.names.filter((n) => n !== row.name).join(", ")}`;
  }
  const report = { zone: zones[0] || "", zones, checked: new Date().toISOString(), collisions, rows };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (collisions.length > 0 && process.argv.includes("--strict")) process.exitCode = 1;
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("no registry entries to probe\n");
    return;
  }
  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows) {
    const code = String(row.probe.status || 0).padStart(3);
    const declared = row.declared.cname.length ? row.declared.cname.join(",") : row.declared.a.join(",");
    process.stdout.write(
      `${row.name.padEnd(width)}  ${code}  ${row.owner.padEnd(14)}  ${row.verdict}\n` +
        `${" ".repeat(width)}        targets ${declared || "none"}\n`,
    );
  }
  if (collisions.length > 0) {
    process.stdout.write(`\n${collisions.length} content collision(s):\n`);
    for (const group of collisions) process.stdout.write(`  ${group.names.join(" = ")}  (${group.digest})\n`);
    if (process.argv.includes("--strict")) process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
