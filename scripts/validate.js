#!/usr/bin/env node

"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DOMAINS_DIR = path.join(ROOT, "domains");
const META_PATH = path.join(DOMAINS_DIR, "_meta.json");

const RESERVED_FILENAMES = new Set(["_meta.json", "_example.json", "SCHEMA.json"]);

function fail(message) {
  console.error(`validate: ${message}`);
  process.exit(1);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// One DNS label: optional leading underscore (e.g. _acme-challenge), then
// the usual letters, digits and hyphens, not ending in a hyphen.
const LABEL_RE = /^_?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function validLabel(label) {
  return typeof label === "string" && label.length > 0 && label.length <= 63 && LABEL_RE.test(label);
}

/**
 * A subdomain is "@", "*", "*.<labels>", or dot-separated labels. Returns
 * the normalized subdomain or null when invalid.
 */
function validSubdomain(sub, maxLength) {
  if (sub === "@" || sub === "*") return true;
  const withoutWildcard = sub.startsWith("*.") ? sub.slice(2) : sub;
  if (withoutWildcard.length === 0) return false;
  if (withoutWildcard.length > 253) return false;
  const labels = withoutWildcard.split(".");
  if (labels.some((l) => !validLabel(l) || l.length > maxLength)) return false;
  return true;
}

function validIPv4(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function validHostname(value) {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 253) return false;
  return value.split(".").every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(l));
}

function validRepo(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  // owner/repo or host/owner/repo
  const withoutGitSuffix = value.replace(/\.git$/i, "");
  const parts = withoutGitSuffix.split("/").filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return false;
  return parts.every((p) => /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(p));
}

function validEmail(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 254) return false;
  const at = value.lastIndexOf("@");
  if (at === -1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length === 0 || local.length > 64) return false;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return validTarget(domain);
}

// --- Public-internet checks -------------------------------------------------
// A registry record is reachable from the public internet by definition, so
// anything that only resolves inside someone's own network is either a
// misconfiguration or a DNS-rebinding setup. Both are rejected here.

/** base/bits pairs that must never appear as a public A record. */
const V4_BLOCKED = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918 private
  ["100.64.0.0", 10], // CGNAT / carrier & VPN space (Tailscale et al.)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata endpoints)
  ["172.16.0.0", 12], // RFC 1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC 1918 private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved / broadcast
];

function ipv4ToInt(value) {
  const p = String(value).split(".").map(Number);
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0);
}

function isPublicIPv4(value) {
  if (!validIPv4(value)) return false;
  const addr = ipv4ToInt(value);
  return !V4_BLOCKED.some(([base, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (ipv4ToInt(base) & mask);
  });
}

/**
 * Expand an IPv6 address into its 8 hextets. Dotted-quad tails (::ffff:1.2.3.4)
 * are returned separately so callers can judge them as IPv4.
 */
function expandIPv6(value) {
  if (!net.isIPv6(value)) return null;
  let addr = value;
  let embedded = null;
  if (addr.includes(".")) {
    const i = addr.lastIndexOf(":");
    embedded = addr.slice(i + 1);
    addr = `${addr.slice(0, i + 1)}0:0`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = head.concat(Array(missing).fill("0"), tail);
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return { nums, embedded };
}

function isPublicIPv6(value) {
  const ex = expandIPv6(value);
  if (!ex) return false;
  // Anything with a dotted-quad tail is really an IPv4 address in disguise.
  if (ex.embedded !== null) return isPublicIPv4(ex.embedded);
  const [a, b, c] = ex.nums;
  if (ex.nums.every((n) => n === 0)) return false; // ::
  if (ex.nums.slice(0, 7).every((n) => n === 0) && ex.nums[7] === 1) return false; // ::1
  if ((a & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((a & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((a & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (a === 0x2001 && b === 0x0db8) return false; // documentation 2001:db8::/32
  if (a === 0x64 && b === 0xff9b) {
    // NAT64 64:ff9b::/96 — the low 32 bits embed an IPv4 address.
    const [g6, g7] = [ex.nums[6], ex.nums[7]];
    return isPublicIPv4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  if (a === 0x2002) {
    // 6to4 2002::/16 — hextets 2 and 3 embed an IPv4 address.
    return isPublicIPv4(`${b >> 8}.${b & 255}.${c >> 8}.${c & 255}`);
  }
  return true;
}

/** Suffixes that only exist inside someone's own machine or LAN. */
const LOCAL_SUFFIXES = new Set([
  "localhost", // RFC 6761
  "local", // mDNS, RFC 6762
  "home.arpa", // RFC 8375 home networking
  "internal",
  "intranet",
  "lan",
  "localdomain",
  "test", // RFC 2606
  "example", // RFC 2606
  "invalid", // RFC 2606
]);

/**
 * Record targets (CNAME/MX/NS/SRV/PTR) must be real public hostnames: at
 * least two labels, not an IP literal, and not a local-only name.
 */
function validTarget(value) {
  if (!validHostname(value)) return false;
  const host = value.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (LOCAL_SUFFIXES.has(labels[labels.length - 1])) return false;
  if (/^\d+$/.test(labels[labels.length - 1])) return false; // IP literal, not a name
  return true;
}

function loadMeta() {
  if (!fs.existsSync(META_PATH)) fail("domains/_meta.json not found");
  const parsed = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  const meta = parsed._meta || parsed;
  return {
    zones: (meta.zones || []).map((s) => String(s).toLowerCase()),
    maintainers: (meta.maintainers || []).map((s) => String(s).toLowerCase()),
    reserved: (meta.reserved || []).map((s) => String(s).toLowerCase()),
    blocked: (meta.blocked || []).map((s) => String(s).toLowerCase()),
    maxLength: typeof meta.maxLength === "number" ? meta.maxLength : 63,
  };
}

/**
 * Validate one registry entry. Every failure is a hard error: this runs on
 * every PR. Wildcard base-ownership is checked separately in checkWildcards,
 * after every file has been seen.
 */
function validateEntry(file, entry, meta, seen, claims, subOwners) {
  const where = file;

  if (!isPlainObject(entry)) fail(`${where}: entry must be a single JSON object (one entry per file)`);

  if (typeof entry.domain !== "string" || entry.domain.length === 0) {
    fail(`${where}: missing "domain" (the zone this subdomain belongs to)`);
  }
  if (entry.domain !== entry.domain.toLowerCase().trim()) {
    fail(`${where}: "domain" must be lowercase`);
  }
  const zone = entry.domain.toLowerCase().trim();
  if (!validHostname(zone)) {
    fail(`${where}: "${entry.domain}" is not a valid zone name`);
  }
  if (meta.zones.length > 0 && !meta.zones.includes(zone)) {
    fail(`${where}: zone "${zone}" is not a managed zone (${meta.zones.join(", ")})`);
  }

  if (typeof entry.subdomain !== "string" || entry.subdomain.length === 0) {
    fail(`${where}: missing "subdomain"`);
  }
  if (entry.subdomain !== entry.subdomain.toLowerCase().trim()) {
    fail(`${where}: "subdomain" must be lowercase`);
  }

  const sub = entry.subdomain.toLowerCase().trim();
  if (!validSubdomain(sub, meta.maxLength)) {
    fail(`${where}: "${entry.subdomain}" is not a valid subdomain (use "@", "*", "*.<labels>", or dot-separated labels)`);
  }

  // The filename must be <subdomain>.<zone>.json so a PR diff always names
  // the full record, and two zones can claim the same label without clashing.
  const expectedFile = `${sub}.${zone}.json`;
  if (path.basename(file) !== expectedFile) {
    fail(`${where}: file must be named "${expectedFile}"`);
  }

  const seenKey = `${zone}/${sub}`;
  if (seen.has(seenKey)) fail(`${where}: "${sub}" is already defined in ${zone}`);
  seen.add(seenKey);

  // Reserved and blocked names only apply to plain single-label claims; a
  // dotted name like _acme-challenge.app is specific enough to stand on its
  // own, and "@" is the zone itself.
  if (!sub.includes(".") && sub !== "@" && sub !== "*") {
    if (meta.reserved.includes(sub)) fail(`${where}: "${sub}" is reserved by the registry`);
    if (meta.blocked.includes(sub)) fail(`${where}: "${sub}" is blocked by the registry`);
  }

  const owner = entry.owner;
  if (typeof owner !== "string" || owner.length === 0) {
    fail(`${where}: missing "owner"`);
  }
  if (owner.length > 39) fail(`${where}: owner "${owner}" is longer than 39 characters`);

  // A bare wildcard covers every unclaimed name in the whole zone, so only
  // maintainers may hold one.
  if (sub === "*" && !meta.maintainers.includes(owner.toLowerCase().trim())) {
    fail(`${where}: a zone-wide wildcard "*" is maintainer-only`);
  }

  // One subdomain per owner per zone: the registry is not a hoarding service.
  // The "@" entry is the zone itself, not a claim, so it does not count
  // against its owner's quota; a maintainer-held bare "*" is infrastructure
  // and is likewise exempt. A wildcard "*.base" is checked against the base
  // claim below instead of counting as a second subdomain.
  if (sub !== "@" && sub !== "*" && !sub.startsWith("*.")) {
    const ownerKey = `${zone}/${owner.toLowerCase()}`;
    if (claims.has(ownerKey)) {
      fail(`${where}: owner "${owner}" already has ${claims.get(ownerKey)} in ${zone}, one subdomain per person`);
    }
    claims.set(ownerKey, `${sub}.${zone}`);
    subOwners.set(`${zone}/${sub}`, owner.toLowerCase());
  }

  if (entry.email !== undefined && !validEmail(entry.email)) {
    fail(`${where}: "email" must be a valid email address, e.g. you@example.com`);
  }
  if (entry.repo !== undefined && !validRepo(entry.repo)) {
    fail(`${where}: "repo" must be a hostname, e.g. github.com/you/repo`);
  }
  if (entry.description !== undefined && typeof entry.description !== "string") {
    fail(`${where}: "description" must be a string`);
  }
  if (entry.proxied !== undefined && typeof entry.proxied !== "boolean") {
    fail(`${where}: "proxied" must be true or false`);
  }

  const records = entry.records;
  if (records === undefined) {
    // Nothing specified at all: the entry gets the GitHub Pages default.
    return;
  }
  if (!isPlainObject(records)) {
    fail(`${where}: "records" must be an object keyed by record type`);
  }

  const allowed = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA", "PTR"];
  for (const key of Object.keys(records)) {
    if (!allowed.includes(key)) {
      fail(`${where}: records.${key} is not a supported record type (${allowed.join(", ")})`);
    }
  }

  if (sub === "@" && records.CNAME !== undefined) {
    fail(`${where}: the zone apex cannot use CNAME records, use A/AAAA instead`);
  }
  if (sub === "@" && records.NS !== undefined) {
    fail(`${where}: the zone apex cannot delegate via NS records`);
  }

  const norm = { A: [], AAAA: [], CNAME: [], TXT: [], MX: [], NS: [], SRV: [], CAA: [], PTR: [] };

  if (records.A !== undefined) {
    if (!Array.isArray(records.A)) fail(`${where}: records.A must be an array`);
    records.A.forEach((v) => {
      if (!isPublicIPv4(v)) fail(`${where}: "${v}" is not a public IPv4 address`);
      norm.A.push(v);
    });
  }
  if (records.AAAA !== undefined) {
    if (!Array.isArray(records.AAAA)) fail(`${where}: records.AAAA must be an array`);
    records.AAAA.forEach((v) => {
      if (!isPublicIPv6(v)) fail(`${where}: "${v}" is not a public IPv6 address`);
      norm.AAAA.push(v);
    });
  }
  if (records.CNAME !== undefined) {
    if (!Array.isArray(records.CNAME)) fail(`${where}: records.CNAME must be an array`);
    records.CNAME.forEach((v) => {
      if (!validTarget(v)) fail(`${where}: "${v}" is not a valid public CNAME target`);
      norm.CNAME.push(v);
    });
  }
  if (records.TXT !== undefined) {
    if (!Array.isArray(records.TXT)) fail(`${where}: records.TXT must be an array`);
    records.TXT.forEach((v) => {
      if (typeof v !== "string" || v.length === 0) fail(`${where}: TXT values must be non-empty strings`);
      if (v.length > 255) fail(`${where}: TXT value exceeds 255 characters`);
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(v)) fail(`${where}: TXT values must not contain control characters`);
      norm.TXT.push(v);
    });
  }
  if (records.MX !== undefined) {
    if (!Array.isArray(records.MX)) fail(`${where}: records.MX must be an array`);
    records.MX.forEach((mx) => {
      if (!isPlainObject(mx) || !Number.isInteger(mx.priority) || !mx.target) {
        fail(`${where}: MX entries must look like { "priority": 10, "target": "mx.example.com" }`);
      }
      if (mx.priority < 0 || mx.priority > 65535) fail(`${where}: MX priority must be 0-65535`);
      if (!validTarget(mx.target)) fail(`${where}: MX target "${mx.target}" is not a public hostname`);
      norm.MX.push({ priority: mx.priority, target: mx.target });
    });
  }
  if (records.NS !== undefined) {
    if (!Array.isArray(records.NS)) fail(`${where}: records.NS must be an array`);
    records.NS.forEach((v) => {
      if (!validTarget(v)) fail(`${where}: "${v}" is not a valid public NS target`);
      norm.NS.push(v);
    });
  }
  if (records.SRV !== undefined) {
    if (!Array.isArray(records.SRV)) fail(`${where}: records.SRV must be an array`);
    records.SRV.forEach((s) => {
      const inRange = (n) => Number.isInteger(n) && n >= 0 && n <= 65535;
      const ok = isPlainObject(s) && inRange(s.priority) && inRange(s.weight) && inRange(s.port) && validTarget(s.target);
      if (!ok) {
        fail(`${where}: SRV entries must look like { "priority": 0, "weight": 5, "port": 25565, "target": "mc.example.com" } (values 0-65535)`);
      }
      norm.SRV.push(s);
    });
  }
  if (records.CAA !== undefined) {
    if (!Array.isArray(records.CAA)) fail(`${where}: records.CAA must be an array`);
    records.CAA.forEach((c) => {
      const ok = isPlainObject(c) && (c.flag === 0 || c.flag === 128) &&
        ["issue", "issuewild", "iodef"].includes(c.tag) &&
        typeof c.value === "string" && c.value.length > 0 && c.value.length <= 255;
      if (!ok) fail(`${where}: CAA entries must look like { "flag": 0, "tag": "issue", "value": "letsencrypt.org" } (tag: issue|issuewild|iodef, flag: 0|128)`);
      norm.CAA.push(c);
    });
  }
  if (records.PTR !== undefined) {
    if (!Array.isArray(records.PTR)) fail(`${where}: records.PTR must be an array`);
    records.PTR.forEach((v) => {
      if (!validTarget(v)) fail(`${where}: "${v}" is not a valid public PTR target`);
      norm.PTR.push(v);
    });
  }

  // An entry with only TXT records (e.g. a bare verification record) is
  // fine. An entry pointing nowhere is not.
  const hasAddressing = norm.A.length + norm.AAAA.length + norm.CNAME.length > 0;
  const hasOnlyTxt = norm.TXT.length > 0 && !hasAddressing;
  if (!hasAddressing && !hasOnlyTxt) {
    fail(`${where}: must define at least one of records.A, records.AAAA, records.CNAME (or records.TXT alone)`);
  }
}

/**
 * A wildcard "*.base" may only widen a name its owner already holds, or an
 * attacker could claim every child of someone else's subdomain.
 */
function checkWildcards(file, entry, subOwners) {
  const sub = entry.subdomain;
  if (typeof sub !== "string" || !sub.startsWith("*.")) return;
  const base = sub.slice(2);
  const zone = entry.domain.toLowerCase();
  const owner = String(entry.owner).toLowerCase();
  const claimKey = `${zone}/${base}`;
  if (subOwners.get(claimKey) !== owner) {
    fail(`${file}: the wildcard "${sub}" needs "${base}" in ${zone} claimed by the same owner first`);
  }
}

function main() {
  const meta = loadMeta();

  if (!fs.existsSync(DOMAINS_DIR)) fail(`domains/ directory not found`);

  const files = fs.readdirSync(DOMAINS_DIR)
    .filter((f) => f.endsWith(".json") && !RESERVED_FILENAMES.has(f))
    .sort();

  if (files.length === 0) {
    console.log("validate: registry is empty, nothing to validate");
    return;
  }

  const seen = new Set();
  const claims = new Map();
  const subOwners = new Map();
  const entries = [];
  let count = 0;

  // Pass 1: parse and validate every file. Wildcard base checks need the
  // full claim map, so they run afterwards.
  for (const file of files) {
    const full = path.join(DOMAINS_DIR, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      fail(`${file}: invalid JSON, ${err.message}`);
    }
    validateEntry(file, parsed, meta, seen, claims, subOwners);
    entries.push({ file, entry: parsed });
    count += 1;
    console.log(`validate: ok, ${file}`);
  }

  // Pass 2: every wildcard must sit on top of the owner's own claim.
  for (const { file, entry } of entries) {
    checkWildcards(file, entry, subOwners);
  }

  console.log(`validate: ${count} entr(y/ies) verified`);
}

main();
