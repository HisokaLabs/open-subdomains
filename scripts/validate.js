#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DOMAINS_DIR = path.join(ROOT, "domains");
const META_PATH = path.join(DOMAINS_DIR, "_meta.json");

const RESERVED_FILENAMES = new Set(["_meta.json", "_example.json", "SCHEMA.json"]);

const { classifyLabel } = require("./name-classes.js");

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function fail(message) {
  throw new ValidationError(message);
}

const JSON_MODE = process.argv.includes("--json");

function isValidationError(err) {
  return err instanceof ValidationError;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preflightEntry(file, entry, meta) {
  const problems = [];
  const push = (message) => problems.push({ file, message: `${file}: ${message}` });

  if (!isPlainObject(entry)) {
    push("entry must be a single JSON object (one entry per file, not an array or a bare string)");
    return problems;
  }

  const allowedKeys = new Set([
    "$schema", "_about", "domain", "subdomain", "owner", "email",
    "proxied", "repo", "description", "records",
  ]);
  for (const key of Object.keys(entry)) {
    if (!allowedKeys.has(key)) {
      push(`unknown key "${key}" (allowed: ${[...allowedKeys].join(", ")})`);
    }
  }

  if (typeof entry.domain !== "string" || entry.domain.trim().length === 0) {
    push('missing "domain" (the zone this subdomain belongs to, e.g. "is-a.ceo")');
  } else if (meta && meta.zones.length > 0) {
    const zone = entry.domain.toLowerCase().trim();
    if (!meta.zones.includes(zone)) {
      push(`zone "${zone}" is not a managed zone (${meta.zones.join(", ")})`);
    }
  }

  if (typeof entry.subdomain !== "string" || entry.subdomain.trim().length === 0) {
    push('missing "subdomain" (the label you are claiming, e.g. "mc")');
  }

  if (entry.owner === undefined) {
    push('missing "owner" (your GitHub username as a plain string, e.g. "octocat")');
  } else if (isPlainObject(entry.owner)) {
    const guess = entry.owner.username || entry.owner.name || entry.owner.login || "";
    push(
      '"owner" must be a plain username string, not an object' +
        (guess ? `; write "owner": "${guess}" instead of "owner": { "username": "${guess}" }` : ""),
    );
  } else if (typeof entry.owner !== "string" || entry.owner.trim().length === 0) {
    push('"owner" must be a non-empty string (your GitHub username)');
  }

  if (entry.records !== undefined && !isPlainObject(entry.records)) {
    push('"records" must be an object keyed by record type, e.g. { "CNAME": "you.vercel.app" }');
  }

  return problems;
}

function advisoryCheck(file, entry, meta) {
  const warnings = [];
  if (isPlainObject(entry) && meta && Array.isArray(meta.advisoryClasses) && meta.advisoryClasses.length > 0) {
    const sub = typeof entry.subdomain === "string" ? entry.subdomain.trim() : "";
    const genericClass = sub && !sub.includes(".") && sub !== "@" && sub !== "*" ? classifyLabel(sub, meta.advisoryClasses) : null;
    if (genericClass) {
      warnings.push({
        file,
        message:
          `${file}: "${sub}" is ${genericClass.label} (${genericClass.why}). ` +
          `This passes the schema, but a maintainer is likely to ask for a personal handle ` +
          `before merging, because a shared word is claimed once and then unavailable to everyone else.`,
      });
    }
  }
  if (!isPlainObject(entry) || !isPlainObject(entry.records)) return warnings;
  const records = entry.records;
  const hasCname = records.CNAME !== undefined;
  const sidecar = [];
  if (records.TXT !== undefined) sidecar.push("TXT");
  if (records.CAA !== undefined) sidecar.push("CAA");
  if (hasCname && sidecar.length > 0) {
    const sub = typeof entry.subdomain === "string" ? entry.subdomain.trim() : "";
    const zone = typeof entry.domain === "string" ? entry.domain.trim() : "";
    const ownName = sub && zone ? `${sub}.${zone}` : "this name";
    warnings.push({
      file,
      message:
        `${file}: records.${sidecar.join(" and records.")} sits on the same name as a CNAME. ` +
        `DNSControl refuses to apply that ("cannot have CNAME and TXT record with same name"), ` +
        `so the DNS push will fail after merge. Move the ${sidecar.join("/")} to its own dotted ` +
        `name, e.g. "subdomain": "_vercel.${sub || "<name>"}" in domains/_vercel.${sub || "<name>"}.${zone || "<zone>"}.json.` +
        ` Current name: ${ownName}.`,
    });
  }
  return warnings;
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
  return parts.every((p) => /^\d{1,3}$/.test(p) && !/^0\d/.test(p) && Number(p) <= 255);
}

function validHostname(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const host = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  return labels.every(
    (l) => l.length > 0 && l.length <= 63 && /^_?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(l)
  );
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
  const [a, b, c, d, e, f, g, h] = ex.nums;
  if (ex.nums.every((n) => n === 0)) return false; // ::
  if (ex.nums.slice(0, 7).every((n) => n === 0) && ex.nums[7] === 1) return false; // ::1
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) ranges carry an
  // IPv4 address in hextet form too, so they are judged as IPv4.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) {
    return isPublicIPv4(`${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`);
  }
  if ((a & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((a & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((a & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (a === 0x2001 && b === 0x0db8) return false; // documentation 2001:db8::/32
  if (a === 0x64 && b === 0xff9b) {
    // NAT64 64:ff9b::/96: the low 32 bits embed an IPv4 address.
    const [g6, g7] = [ex.nums[6], ex.nums[7]];
    return isPublicIPv4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  if (a === 0x2002) {
    // 6to4 2002::/16: hextets 2 and 3 embed an IPv4 address.
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
  "ts.net", // Tailscale MagicDNS private networking
]);

/** True when the host is one of the suffixes or sits underneath it. */
function hasLocalSuffix(host) {
  return [...LOCAL_SUFFIXES].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Record targets (CNAME/MX/NS/SRV/PTR) must be real public hostnames: at
 * least two labels, not an IP literal, and not a local-only name.
 */
function validTarget(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const host = (trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed).toLowerCase();
  if (!validHostname(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (hasLocalSuffix(host)) return false;
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/i.test(tld) && !/^xn--[a-z0-9-]{2,59}$/i.test(tld)) return false;
  return true;
}

function loadMeta() {
  if (!fs.existsSync(META_PATH)) fail("domains/_meta.json not found");
  const parsed = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  const meta = parsed._meta || parsed;
  const policy = meta.namePolicy || {};
  return {
    zones: (meta.zones || []).map((s) => String(s).toLowerCase()),
    maintainers: (meta.maintainers || []).map((s) => String(s).toLowerCase()),
    reserved: (meta.reserved || []).map((s) => String(s).toLowerCase()),
    blocked: (meta.blocked || []).map((s) => String(s).toLowerCase()),
    maxLength: typeof meta.maxLength === "number" ? meta.maxLength : 63,
    reservedClasses: (policy.reservedClasses || []).map((s) => String(s).toLowerCase()),
    advisoryClasses: (policy.advisoryClasses || []).map((s) => String(s).toLowerCase()),
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

  // Mirrors SCHEMA.json's additionalProperties: false. A key that the site and
  // dnsconfig.js both ignore is a typo waiting to be trusted.
  const allowedKeys = new Set([
    "$schema", "_about", "domain", "subdomain", "owner", "email",
    "proxied", "repo", "description", "records",
  ]);
  for (const key of Object.keys(entry)) {
    if (!allowedKeys.has(key)) fail(`${where}: unknown key "${key}" (allowed: ${[...allowedKeys].join(", ")})`);
  }

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
    const reservedClass = classifyLabel(sub, meta.reservedClasses);
    if (reservedClass) {
      fail(
        `${where}: "${sub}" is ${reservedClass.label}, and this registry keeps those names unclaimed ` +
          `(${reservedClass.why}); pick a personal handle instead`,
      );
    }
  }

  if (typeof entry.owner === "string") entry.owner = entry.owner.trim();
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
  // claim below instead of counting as a second subdomain, and an
  // underscore-prefixed record (_acme-challenge.base, _dmarc.base) is an
  // auxiliary record for a name the owner already had to claim.
  const auxiliary = sub.includes(".") && sub.split(".")[0].startsWith("_");
  if (sub !== "@" && sub !== "*" && !sub.startsWith("*.") && !auxiliary) {
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
    if (typeof records.CNAME !== "string" && !Array.isArray(records.CNAME)) {
      fail(`${where}: records.CNAME must be a string or array of strings`);
    }
    const rawCname = Array.isArray(records.CNAME) ? records.CNAME : [records.CNAME];
    if (rawCname.length === 0) {
      fail(`${where}: records.CNAME cannot be empty`);
    }
    if (rawCname.length > 1) {
      fail(`${where}: records.CNAME can only have a single target (DNS forbids multiple CNAMEs on the same name)`);
    }
    rawCname.forEach((v) => {
      if (typeof v !== "string" || !validTarget(v)) {
        fail(`${where}: "${v}" is not a valid public CNAME target`);
      }
      const targetHost = (v.trim().endsWith(".") ? v.trim().slice(0, -1) : v.trim()).toLowerCase();
      const ownFqdn = sub === "@" ? zone : `${sub}.${zone}`;
      if (targetHost === ownFqdn || targetHost === zone) {
        fail(`${where}: CNAME target "${v}" cannot point to itself or the zone apex`);
      }
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

  // CNAME is exclusive: RFC 1034/2181 allow no other record type on the same
  // name. Everything except DNSSEC records is rejected here.
  const exclusive = ["A", "AAAA", "MX", "NS", "SRV", "PTR"];
  const clashing = exclusive.filter((kind) => norm[kind].length > 0);
  if (norm.CNAME.length > 0 && clashing.length > 0) {
    fail(`${where}: a CNAME cannot coexist with ${clashing.join(", ")} on the same name`);
  }

  for (const kind of ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA", "PTR"]) {
    const keys = norm[kind].map((v) => {
      if (typeof v === "string") {
        return kind === "TXT" ? v : v.trim().toLowerCase().replace(/\.$/, "");
      }
      if (kind === "MX") {
        return JSON.stringify({ priority: v.priority, target: v.target.trim().toLowerCase().replace(/\.$/, "") });
      }
      if (kind === "SRV") {
        return JSON.stringify({
          priority: v.priority,
          weight: v.weight,
          port: v.port,
          target: v.target.trim().toLowerCase().replace(/\.$/, ""),
        });
      }
      return JSON.stringify(v);
    });
    if (new Set(keys).size !== keys.length) fail(`${where}: records.${kind} contains a duplicate value`);
  }

  // An entry pointing nowhere is not useful; every record-only shape that a
  // real service needs is accepted below.
  const hasAddressing = norm.A.length + norm.AAAA.length + norm.CNAME.length > 0;
  const hasOnlyTxt = norm.TXT.length > 0 && !hasAddressing;
  const hasDelegation = norm.NS.length > 0;
  const hasMail = norm.MX.length > 0;
  const hasService = norm.SRV.length > 0;
  const hasReverse = norm.PTR.length > 0;
  if (!hasAddressing && !hasOnlyTxt && !hasDelegation && !hasMail && !hasService && !hasReverse) {
    fail(`${where}: must define at least one of records.A, AAAA, CNAME, MX, NS, SRV, PTR, or TXT alone`);
  }
}

/**
 * A wildcard "*.base" or an auxiliary record such as "_acme-challenge.base"
 * may only sit on a name its owner already holds, or an attacker could claim
 * every child of someone else's subdomain and issue TLS certificates for it
 * or forge their mail policy. Service discovery records (SRV, e.g.
 * _minecraft._tcp.mc) carry no such privilege and stay open.
 */
function checkOwnedBase(file, entry, subOwners) {
  const sub = entry.subdomain;
  if (typeof sub !== "string" || !sub.includes(".")) return;
  const labels = sub.split(".");
  const records = isPlainObject(entry.records) ? entry.records : {};
  const serviceOnly = Array.isArray(records.SRV) &&
    !records.A && !records.AAAA && !records.CNAME && !records.TXT && !records.MX && !records.NS && !records.PTR;
  let index = 0;
  if (labels[0] === "*") {
    index = 1;
  } else if (serviceOnly) {
    return;
  }
  while (index < labels.length - 1 && labels[index].startsWith("_")) index += 1;
  const base = labels.slice(index).join(".");
  if (base.length === 0 || base === sub) return;
  const zone = entry.domain.toLowerCase();
  const owner = String(entry.owner).toLowerCase();
  if (subOwners.get(`${zone}/${base}`) !== owner) {
    fail(`${file}: "${sub}" needs "${base}" in ${zone} claimed by the same owner first`);
  }
}

function checkNonJsonClaims(problems) {
  if (!fs.existsSync(DOMAINS_DIR)) return;
  for (const name of fs.readdirSync(DOMAINS_DIR).sort()) {
    if (name.startsWith(".") || name.toLowerCase().endsWith(".json")) continue;
    const full = path.join(DOMAINS_DIR, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let looksLikeClaim = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      looksLikeClaim = isPlainObject(parsed) && ("domain" in parsed || "subdomain" in parsed || "owner" in parsed);
    } catch {
      looksLikeClaim = false;
    }
    if (!looksLikeClaim) continue;
    problems.push({
      file: name,
      message:
        `${name}: this is a registry entry without a .json extension, so the validator ` +
        `and the DNS config glob both skip it; rename it to "${name}.json"`,
    });
  }
}

function checkMisplacedRootFiles() {
  const knownRootConfigs = new Set([
    "package.json",
    "package-lock.json",
    "creds.json",
    "tsconfig.json",
  ]);

  for (const rf of fs.readdirSync(ROOT)) {
    if (!rf.endsWith(".json") || knownRootConfigs.has(rf)) continue;
    const full = path.join(ROOT, rf);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      if (isPlainObject(parsed) && (parsed.domain || parsed.subdomain)) {
        fail(`${rf}: domain files must be placed in the domains/ directory, not in the repository root`);
      }
    } catch {
      // Ignored if file cannot be parsed as JSON
    }
    if (rf.split(".").length >= 3) {
      fail(`${rf}: domain files must be placed in the domains/ directory, not in the repository root`);
    }
  }
}

function snapshotState(seen, claims, subOwners) {
  return { seen: new Set(seen), claims: new Map(claims), subOwners: new Map(subOwners) };
}

function restoreState(seen, claims, subOwners, snap) {
  seen.clear();
  snap.seen.forEach((v) => seen.add(v));
  claims.clear();
  snap.claims.forEach((v, k) => claims.set(k, v));
  subOwners.clear();
  snap.subOwners.forEach((v, k) => subOwners.set(k, v));
}

function main() {
  const problems = [];

  try {
    checkMisplacedRootFiles();
  } catch (err) {
    if (!isValidationError(err)) throw err;
    problems.push({ file: null, message: err.message });
  }

  checkNonJsonClaims(problems);

  let meta;
  try {
    meta = loadMeta();
  } catch (err) {
    if (!isValidationError(err)) throw err;
    problems.push({ file: null, message: err.message });
  }

  if (!meta) return report(problems, [], []);
  if (!fs.existsSync(DOMAINS_DIR)) {
    problems.push({ file: null, message: "domains/ directory not found" });
    return report(problems, [], []);
  }

  const files = fs.readdirSync(DOMAINS_DIR)
    .filter((f) => f.endsWith(".json") && !RESERVED_FILENAMES.has(f))
    .sort();

  const seen = new Set();
  const claims = new Map();
  const subOwners = new Map();
  const entries = [];
  const warnings = [];

  // Pass 1: parse and validate every file. Wildcard base checks need the
  // full claim map, so they run afterwards.
  for (const file of files) {
    const full = path.join(DOMAINS_DIR, file);
    const snap = snapshotState(seen, claims, subOwners);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (err) {
      problems.push({ file, message: `${file}: invalid JSON, ${err.message}` });
      continue;
    }
    const preflight = preflightEntry(file, parsed, meta);
    if (preflight.length > 0) {
      problems.push(...preflight);
      continue;
    }
    warnings.push(...advisoryCheck(file, parsed, meta));
    try {
      validateEntry(file, parsed, meta, seen, claims, subOwners);
    } catch (err) {
      if (!isValidationError(err)) throw err;
      restoreState(seen, claims, subOwners, snap);
      problems.push({ file, message: err.message });
      continue;
    }
    entries.push({ file, entry: parsed });
    if (!JSON_MODE) console.log(`validate: ok, ${file}`);
  }

  // Pass 2: every wildcard and every underscore-prefixed name must sit on top
  // of the owner's own claim.
  for (const { file, entry } of entries) {
    try {
      checkOwnedBase(file, entry, subOwners);
    } catch (err) {
      if (!isValidationError(err)) throw err;
      problems.push({ file, message: err.message });
    }
  }

  report(problems, entries.map((e) => e.file), warnings);
}

function report(problems, verified, warnings = []) {
  if (JSON_MODE) {
    const payload = { ok: problems.length === 0, verified, problems, warnings };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const problem of problems) console.error(`validate: ${problem.message}`);
    for (const warning of warnings) console.error(`validate: warning: ${warning.message}`);
    if (problems.length > 0) {
      console.error(`validate: ${problems.length} problem(s) found`);
    } else if (verified.length === 0) {
      console.log("validate: registry is empty, nothing to validate");
    } else {
      console.log(`validate: ${verified.length} entr(y/ies) verified`);
    }
  }
  if (problems.length > 0) process.exit(1);
}

main();
