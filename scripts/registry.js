"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DOMAINS_DIR = path.join(ROOT, "domains");
const POLICY_DIR = path.join(ROOT, "registry");

const MAX_LABEL = 63;
const MAX_NAME = 253;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_VALUES = 20;

const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA", "PTR"];
const ENTRY_KEYS = new Set(["$schema", "owner", "repo", "description", "proxied", "records"]);
const OWNER_KEYS = new Set(["username", "id", "email"]);

class RegistryError extends Error {}

function fail(message) {
  throw new RegistryError(message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    fail(`${path.relative(ROOT, file)}: could not be read`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const position = /at position (\d+)/.exec(err.message);
    fail(`${path.relative(ROOT, file)}: invalid JSON${position ? ` at position ${position[1]}` : ""}`);
  }
}

function loadPolicy(dir = POLICY_DIR) {
  const zones = readJson(path.join(dir, "zones.json"));
  if (!Array.isArray(zones) || zones.length === 0) fail("registry/zones.json must list at least one zone");

  const lower = (list, file) => {
    if (!Array.isArray(list)) fail(`registry/${file} must be a JSON array`);
    return list.map((value) => String(value).trim().toLowerCase());
  };

  const trusted = readJson(path.join(dir, "trusted.json"));
  if (!Array.isArray(trusted)) fail("registry/trusted.json must be a JSON array");

  return {
    zones: lower(zones, "zones.json"),
    reserved: new Set(lower(readJson(path.join(dir, "reserved.json")), "reserved.json")),
    blocked: new Set(lower(readJson(path.join(dir, "blocked.json")), "blocked.json")),
    trusted: trusted.map((person) => {
      if (!isPlainObject(person) || !person.username) fail("registry/trusted.json entries need a username");
      return {
        username: String(person.username).trim().toLowerCase(),
        id: Number.isInteger(person.id) ? person.id : null,
        admin: person.admin === true,
      };
    }),
  };
}

function trustedBy(policy, author) {
  if (!author) return null;
  if (Number.isInteger(author.id) && author.id > 0) {
    const byId = policy.trusted.find((person) => person.id === author.id);
    if (byId) return byId;
  }
  if (typeof author.username === "string" && author.username.trim()) {
    const name = author.username.trim().toLowerCase();
    return policy.trusted.find((person) => person.username === name) || null;
  }
  return null;
}

/**
 * The current author, from the environment CI passes in. An id is the identity
 * that survives a rename, so it wins when both are available.
 */
function currentAuthor(env = process.env) {
  const rawId = String(env.PR_AUTHOR_ID || "").trim();
  const id = /^\d+$/.test(rawId) ? Number(rawId) : null;
  const username = String(env.PR_AUTHOR || "").trim().replace(/^@/, "");
  if (!id && !username) return null;
  return { id, username };
}

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 6: "g", 7: "t", 8: "b", 9: "g", "@": "a", $: "s", "!": "i", "+": "t" };

/**
 * Reduces a label to the word it dresses up as, so m3, meee and m_e all land on
 * "me". Without this the reserved list only catches the spelling someone
 * happened to write down.
 */
function fold(label) {
  return String(label)
    .toLowerCase()
    .replace(/[-_.\s]/g, "")
    .replace(/[013456789@$!+]/g, (char) => LEET[char] || char)
    .replace(/(.)\1{2,}/g, "$1");
}

function reservedWord(label, policy) {
  const plain = String(label).toLowerCase();
  if (policy.reserved.has(plain)) return plain;
  const folded = fold(label);
  return policy.reserved.has(folded) ? folded : null;
}

const LABEL_RE = /^_?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function validLabel(label) {
  return typeof label === "string" && label.length > 0 && label.length <= MAX_LABEL && LABEL_RE.test(label);
}

function validSubdomain(subdomain) {
  if (subdomain === "@" || subdomain === "*") return true;
  const rest = subdomain.startsWith("*.") ? subdomain.slice(2) : subdomain;
  if (rest.length === 0 || rest.length > MAX_NAME) return false;
  return rest.split(".").every(validLabel);
}

/**
 * Reads the claim name out of the filename, which is the only place it is
 * written. That removes the whole class of "file says X, name is Y" failures.
 */
function parseClaimFile(filename, zones) {
  if (!filename.endsWith(".json")) return null;
  const stem = filename.slice(0, -".json".length);
  for (const zone of zones) {
    if (!stem.endsWith(`.${zone}`)) continue;
    const subdomain = stem.slice(0, -(zone.length + 1));
    if (subdomain.length === 0) return null;
    return { subdomain, zone };
  }
  return null;
}

function claimFile(subdomain, zone) {
  return `${subdomain}.${zone}.json`;
}

function isApex(subdomain) {
  return subdomain === "@";
}

/** Names that answer for the whole zone rather than one label: @, *, _dmarc. */
function isZoneWide(subdomain) {
  return subdomain === "@" || subdomain === "*" || (subdomain.startsWith("_") && !subdomain.includes("."));
}

/** A record under someone else's name, e.g. _vercel.jane or _acme-challenge.app. */
function isAuxiliary(subdomain) {
  return subdomain.includes(".") && subdomain.split(".")[0].startsWith("_");
}

function validIPv4(value) {
  const parts = String(value).split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && !/^0\d/.test(p) && Number(p) <= 255);
}

function validHostname(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const host = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (host.length === 0 || host.length > MAX_NAME) return false;
  return host.split(".").every((label) => label.length <= MAX_LABEL && /^_?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label));
}

function validRepo(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  if (/^https?:\/\//i.test(value)) {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  const parts = value.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return false;
  return parts.every((part) => /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(part));
}

function validEmail(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 254) return false;
  const at = value.lastIndexOf("@");
  if (at === -1) return false;
  const local = value.slice(0, at);
  if (local.length === 0 || local.length > 64) return false;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return validTarget(value.slice(at + 1));
}

const V4_BLOCKED = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(value) {
  const parts = String(value).split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPublicIPv4(value) {
  if (!validIPv4(value)) return false;
  const addr = ipv4ToInt(value);
  return !V4_BLOCKED.some(([base, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) === (ipv4ToInt(base) & mask);
  });
}

function expandIPv6(value) {
  if (!net.isIPv6(value)) return null;
  let addr = value;
  let embedded = null;
  if (addr.includes(".")) {
    const cut = addr.lastIndexOf(":");
    embedded = addr.slice(cut + 1);
    addr = `${addr.slice(0, cut + 1)}0:0`;
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
  const nums = groups.map((group) => parseInt(group, 16));
  if (nums.some((n) => Number.isNaN(n))) return null;
  return { nums, embedded };
}

function embeddedIPv4(hi, lo) {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isPublicIPv6(value) {
  const expanded = expandIPv6(value);
  if (!expanded) return false;
  if (expanded.embedded !== null) return isPublicIPv4(expanded.embedded);
  const n = expanded.nums;
  if (n.every((part) => part === 0)) return false;
  if (n.slice(0, 7).every((part) => part === 0) && n[7] === 1) return false;
  if (n[0] === 0 && n[1] === 0 && n[2] === 0 && n[3] === 0 && n[4] === 0 && (n[5] === 0xffff || n[5] === 0)) {
    return isPublicIPv4(embeddedIPv4(n[6], n[7]));
  }
  if ((n[0] & 0xffc0) === 0xfe80) return false;
  if ((n[0] & 0xfe00) === 0xfc00) return false;
  if ((n[0] & 0xff00) === 0xff00) return false;
  if (n[0] === 0x2001 && n[1] === 0x0db8) return false;
  if (n[0] === 0x64 && n[1] === 0xff9b) return isPublicIPv4(embeddedIPv4(n[6], n[7]));
  if (n[0] === 0x2002) return isPublicIPv4(embeddedIPv4(n[1], n[2]));
  return true;
}

const LOCAL_SUFFIXES = new Set([
  "localhost", "local", "home.arpa", "internal", "intranet", "lan",
  "localdomain", "test", "example", "invalid", "ts.net",
]);

function validTarget(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const host = (trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed).toLowerCase();
  if (!validHostname(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if ([...LOCAL_SUFFIXES].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return false;
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld);
}

const VERIFY_RE = /^vc-domain-verify=([^,\s]+),([0-9A-Za-z_-]+)$/;

function fqdnOf(subdomain, zone) {
  return isApex(subdomain) ? zone : `${subdomain}.${zone}`;
}

function loadClaims(dir = DOMAINS_DIR, { all = false } = {}) {
  if (!fs.existsSync(dir)) fail("domains/ not found");
  const claims = fs
    .readdirSync(dir)
    .sort()
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => ({ filename, full: path.join(dir, filename) }));
  return all ? claims : claims.filter(({ full }) => fs.lstatSync(full).isFile());
}

function ownerOf(entry) {
  return isPlainObject(entry) && isPlainObject(entry.owner) ? entry.owner : null;
}

function ownerUsername(entry) {
  const owner = ownerOf(entry);
  if (!owner || typeof owner.username !== "string") return "";
  return owner.username.trim().toLowerCase();
}

/**
 * A stable identity for whoever holds an entry, used for the anti-takeover
 * rules. Any one of the three keys is enough to own a name, so the key falls
 * back through id, then username, then email. Returning "" for an entry with
 * none of them keeps two strangers from matching each other on an empty string.
 */
function ownerKey(entry) {
  const owner = ownerOf(entry);
  if (!owner) return "";
  if (Number.isInteger(owner.id) && owner.id > 0) return `id:${owner.id}`;
  if (typeof owner.username === "string" && owner.username.trim()) {
    return `user:${owner.username.trim().toLowerCase()}`;
  }
  if (typeof owner.email === "string" && owner.email.trim()) {
    return `mail:${owner.email.trim().toLowerCase()}`;
  }
  return "";
}

function ownerLabel(entry) {
  const owner = ownerOf(entry);
  if (!owner) return "-";
  if (typeof owner.username === "string" && owner.username.trim()) return owner.username.trim();
  if (Number.isInteger(owner.id)) return `id:${owner.id}`;
  if (typeof owner.email === "string" && owner.email.trim()) return owner.email.trim();
  return "-";
}

module.exports = {
  ROOT,
  DOMAINS_DIR,
  POLICY_DIR,
  MAX_LABEL,
  MAX_NAME,
  MAX_FILE_BYTES,
  MAX_VALUES,
  RECORD_TYPES,
  ENTRY_KEYS,
  OWNER_KEYS,
  VERIFY_RE,
  RegistryError,
  fail,
  isPlainObject,
  readJson,
  loadPolicy,
  loadClaims,
  trustedBy,
  currentAuthor,
  fold,
  reservedWord,
  validLabel,
  validSubdomain,
  parseClaimFile,
  claimFile,
  isApex,
  isZoneWide,
  isAuxiliary,
  fqdnOf,
  validHostname,
  validRepo,
  validEmail,
  isPublicIPv4,
  isPublicIPv6,
  validTarget,
  ownerOf,
  ownerUsername,
  ownerKey,
  ownerLabel,
};
