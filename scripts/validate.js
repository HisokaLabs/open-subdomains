#!/usr/bin/env node

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const R = require("./registry.js");

const JSON_MODE = process.argv.includes("--json");

const CLAIM_LIMIT = 4;

const CODE_PATHS = ["scripts/", "test/", "dnsconfig.js", "package.json", "package-lock.json"];
const POLICY_PATHS = ["registry/"];
const CI_PATHS = [".github/"];
const DOCS = new Set(["README.md", "CONTRIBUTING.md", "AGENTS.md", "LICENSE", ".gitignore", ".gitattributes"]);

function git(args) {
  try {
    return execFileSync("git", args, { cwd: R.ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function baseName() {
  return process.env.GITHUB_BASE_REF || "main";
}

/**
 * Whether this run is judging a pull request rather than a branch.
 *
 * GITHUB_BASE_REF is the reliable signal, and it is what CI sets. PR_AUTHOR is
 * not enough on its own: a local run can pass it to exercise the claimant rules
 * while sitting on main, and the six entries that person already committed are
 * not a claim pull request. On the base branch the diff against its own upstream
 * is every unpushed commit, so the scope rules step aside.
 */
function judgingPullRequest() {
  if (process.env.GITHUB_BASE_REF) return true;
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return true;
  return branch.trim() !== baseName();
}

function changedFiles() {
  const fromEnv = process.env.CHANGED_FILES;
  if (fromEnv && fromEnv.trim()) {
    let list;
    try {
      const parsed = JSON.parse(fromEnv);
      list = Array.isArray(parsed) ? parsed : null;
    } catch {
      list = null;
    }
    if (!list) list = fromEnv.split("\n").map((line) => line.trim());
    return list.filter(Boolean).map((file) => ({ status: "?", path: file.replace(/\\/g, "/") }));
  }

  const flag = process.argv.indexOf("--files");
  if (flag !== -1) {
    return process.argv
      .slice(flag + 1)
      .filter((arg) => !arg.startsWith("--"))
      .map((file) => ({ status: "?", path: file.replace(/\\/g, "/") }));
  }

  if (!judgingPullRequest()) return null;

  for (const range of [`origin/${baseName()}...HEAD`, `${baseName()}...HEAD`]) {
    const out = git(["diff", "--no-renames", "--name-status", range]);
    if (out === null) continue;
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split(/\s+/);
        return { status: status[0], path: rest.join(" ").replace(/\\/g, "/") };
      });
  }
  return null;
}

function baseFile(file) {
  const ref = `origin/${baseName()}`;
  return git(["show", `${ref}:${file}`]) ?? git(["show", `${baseName()}:${file}`]);
}

function basePolicy() {
  const files = ["zones.json", "reserved.json", "blocked.json", "trusted.json"];
  const out = {};
  for (const file of files) {
    const raw = baseFile(`registry/${file}`);
    if (raw === null) return null;
    try {
      out[file] = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return {
    zones: out["zones.json"].map((z) => String(z).toLowerCase()),
    reserved: new Set(out["reserved.json"].map((w) => String(w).toLowerCase())),
    blocked: new Set(out["blocked.json"].map((w) => String(w).toLowerCase())),
    trusted: out["trusted.json"].map((p) => ({
      username: String(p.username || "").toLowerCase(),
      id: Number.isInteger(p.id) ? p.id : null,
      admin: p.admin === true,
    })),
  };
}

function checkLayout(problems) {
  const push = (message) => problems.push({ file: null, message });

  for (const name of fs.readdirSync(R.ROOT)) {
    if (!name.endsWith(".json")) continue;
    if (["package.json", "package-lock.json", "creds.json", "tsconfig.json"].includes(name)) continue;
    if (name.split(".").length >= 3) {
      push(`${name}: entries live in domains/, not the repository root`);
    }
  }

  if (!fs.existsSync(R.DOMAINS_DIR)) {
    push("domains/ not found");
    return;
  }

  const dirs = [];
  for (const name of fs.readdirSync(R.DOMAINS_DIR)) {
    if (name.startsWith(".")) continue;
    const full = path.join(R.DOMAINS_DIR, name);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      dirs.push(name);
      continue;
    }
    if (!name.endsWith(".json")) {
      push(`domains/${name}: every entry filename ends in .json, so the validator and dnsconfig.js both see it`);
    }
  }
  if (dirs.length > 0) {
    push(`domains/ holds subdirectories (${dirs.slice(0, 5).join(", ")}); entries stay flat so each one is checked before it reaches DNS`);
  }
}

function checkPolicyChange(problems, policy, base, actor, author) {
  if (!base || !author) return;
  const push = (message) => problems.push({ file: null, message });

  const wasTrusted = R.trustedBy(base, author);
  if (!wasTrusted) {
    const added = policy.trusted.filter(
      (person) => !base.trusted.some((old) => (person.id && old.id === person.id) || old.username === person.username),
    );
    if (added.length > 0) {
      push(`registry/trusted.json: this pull request adds ${added.map((p) => `"${p.username}"`).join(", ")}; only an admin can grant trust`);
    }
    for (const [key, file] of [["reserved", "reserved.json"], ["blocked", "blocked.json"]]) {
      const dropped = [...base[key]].filter((word) => !policy[key].has(word));
      if (dropped.length > 0) {
        push(`registry/${file}: this pull request drops ${dropped.slice(0, 5).map((w) => `"${w}"`).join(", ")}; only trusted authors can loosen the name policy`);
      }
    }
    if (policy.zones.join(",") !== base.zones.join(",")) {
      push("registry/zones.json: only a trusted author can change which zones are served");
    }
    return;
  }

  if (!wasTrusted.admin) {
    const changed =
      policy.trusted.length !== base.trusted.length ||
      policy.trusted.some((person) => !base.trusted.some((old) => old.username === person.username && old.id === person.id && old.admin === person.admin));
    if (changed) push("registry/trusted.json: only an admin can change the trusted list");
  }
}

function checkOwner(file, entry, author, actor) {
  const where = file;
  const owner = entry.owner;

  if (!R.isPlainObject(owner)) {
    R.fail(`${where}: "owner" must be an object, e.g. { "username": "jane", "id": 1234567 }`);
  }
  for (const key of Object.keys(owner)) {
    if (!R.OWNER_KEYS.has(key)) R.fail(`${where}: unknown owner key "${key}" (allowed: ${[...R.OWNER_KEYS].join(", ")})`);
  }

  // Any one of the three identifies the holder, so none of them is required on
  // its own. The rule is only that the object is not empty.
  const hasUsername = typeof owner.username === "string" && owner.username.trim().length > 0;
  const hasId = owner.id !== undefined;
  const hasEmail = typeof owner.email === "string" && owner.email.trim().length > 0;

  if (!hasUsername && !hasId && !hasEmail) {
    R.fail(
      `${where}: "owner" is empty. Give at least one of "username", "id" or "email": ` +
        `"username" is your GitHub handle, "id" is the number in https://api.github.com/users/<handle>, ` +
        `and "email" is an address a maintainer can reach`,
    );
  }

  if (owner.username !== undefined) {
    if (!hasUsername) R.fail(`${where}: owner.username is empty; remove the key or write your GitHub handle`);
    const username = owner.username.trim();
    if (username.length > 39) R.fail(`${where}: owner.username is longer than the 39 characters GitHub allows`);
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(username)) {
      R.fail(`${where}: owner.username "${username}" is not a GitHub handle (letters, digits and single hyphens)`);
    }
  }

  if (owner.id !== undefined && (!Number.isInteger(owner.id) || owner.id <= 0)) {
    R.fail(`${where}: owner.id must be the numeric GitHub account id, e.g. 1234567`);
  }

  if (owner.email !== undefined && !R.validEmail(owner.email)) {
    R.fail(`${where}: owner.email must be a valid address, e.g. "you@example.com"`);
  }
}

/**
 * Ties the claim to whoever opened the pull request. A trusted author edits any
 * entry they like; everyone else only their own. The numeric id wins when both
 * sides have one, because a username can be released and taken again.
 *
 * An entry identified only by email has nothing to match against an account, so
 * the claim is refused rather than waved through: without it, anyone could file
 * a name under any address they like and the pull request author check would
 * have nothing to compare.
 */
function checkClaimant(file, entry, author, actor) {
  if (actor || !author) return;
  const owner = R.ownerOf(entry);
  if (!owner) return;

  if (Number.isInteger(owner.id)) {
    if (!author.id) {
      R.fail(`${file}: owner.id ${owner.id} cannot be checked because this run does not know the author id`);
    }
    if (owner.id !== author.id) {
      R.fail(
        `${file}: owner.id ${owner.id} is not the account opening this pull request (${author.id}); ` +
          `a name cannot be claimed for someone else`,
      );
    }
    return;
  }

  const username = R.ownerUsername(entry);
  if (username) {
    if (!author.username) {
      R.fail(`${file}: owner.username "${username}" cannot be checked because this run does not know the author`);
    }
    if (username !== author.username.toLowerCase()) {
      R.fail(
        `${file}: owner.username "${owner.username}" is not the account opening this pull request ` +
          `("${author.username}"); add "id" to the owner object to match on the numeric account`,
      );
    }
    return;
  }

  R.fail(
    `${file}: this entry has only an email, so it cannot be tied to the account opening this pull request. ` +
      `Add "username" or "id" to owner, or let a trusted author file it`,
  );
}

function checkName(file, name, policy, ownerIsTrusted) {
  const where = file;
  const sub = name.subdomain;
  const zone = name.zone;

  if (!policy.zones.includes(zone)) {
    R.fail(`${where}: "${zone}" is not a managed zone (${policy.zones.join(", ")})`);
  }
  if (sub !== sub.toLowerCase()) R.fail(`${where}: the subdomain must be lowercase`);
  if (!R.validSubdomain(sub)) {
    R.fail(`${where}: "${sub}" is not a valid subdomain (use "@", "*", "*.<labels>", or dot-separated labels)`);
  }

  const single = !sub.includes(".") && sub !== "@" && sub !== "*";
  if (!single) return;

  // Blocked means impersonation: a brand or a role the zone will never host.
  // It holds for every author, the DNS administration included, because there
  // is no legitimate reason to answer as paypal.is-a.ceo.
  if (policy.blocked.has(sub)) {
    R.fail(`${where}: "${sub}" is blocked by the registry and cannot be claimed under any zone`);
  }

  // Reserved means the DNS administration already points it somewhere, so it is
  // not free. Those authors are the administration, so the rule is theirs.
  const word = R.reservedWord(sub, policy);
  if (word && !ownerIsTrusted) {
    R.fail(
      `${where}: "${sub}" is reserved, so it already answers for the registry${word === sub.toLowerCase() ? "" : ` (it reads as "${word}")`}. ` +
        `Pick a personal handle instead`,
    );
  }
}

function normalizeRecords(entry, sub, zone) {
  const where = entry.file;
  const raw = entry.body.records;
  if (raw === undefined) return null;
  if (!R.isPlainObject(raw)) R.fail(`${where}: "records" must be an object keyed by record type`);

  for (const key of Object.keys(raw)) {
    if (!R.RECORD_TYPES.includes(key)) {
      R.fail(`${where}: records.${key} is not a supported type (${R.RECORD_TYPES.join(", ")})`);
    }
    if (Array.isArray(raw[key]) && raw[key].length === 0) R.fail(`${where}: records.${key} is empty; remove the key instead`);
    if (Array.isArray(raw[key]) && raw[key].length > R.MAX_VALUES) {
      R.fail(`${where}: records.${key} has ${raw[key].length} values, the limit is ${R.MAX_VALUES}`);
    }
  }

  const out = {};
  const list = (kind) => (Array.isArray(raw[kind]) ? raw[kind] : null);

  if (raw.A !== undefined) {
    if (!list("A")) R.fail(`${where}: records.A must be an array`);
    out.A = raw.A.map((value) => {
      if (!R.isPublicIPv4(value)) R.fail(`${where}: "${value}" is not a public IPv4 address`);
      return value;
    });
  }
  if (raw.AAAA !== undefined) {
    if (!list("AAAA")) R.fail(`${where}: records.AAAA must be an array`);
    out.AAAA = raw.AAAA.map((value) => {
      if (!R.isPublicIPv6(value)) R.fail(`${where}: "${value}" is not a public IPv6 address`);
      return value;
    });
  }
  if (raw.CNAME !== undefined) {
    const targets = Array.isArray(raw.CNAME) ? raw.CNAME : [raw.CNAME];
    if (targets.length > 1) {
      R.fail(`${where}: records.CNAME takes one target, because DNS forbids two CNAMEs on one name`);
    }
    const target = targets[0];
    if (typeof target !== "string" || !R.validTarget(target)) {
      R.fail(`${where}: "${target}" is not a valid public CNAME target`);
    }
    const plain = target.trim().toLowerCase().replace(/\.$/, "");
    if (plain === zone || plain === R.fqdnOf(sub, zone)) {
      R.fail(`${where}: CNAME target "${target}" cannot point at the name it sits on, or at the apex`);
    }
    out.CNAME = target;
  }
  if (raw.TXT !== undefined) {
    if (!list("TXT")) R.fail(`${where}: records.TXT must be an array`);
    out.TXT = raw.TXT.map((value) => {
      if (typeof value !== "string" || value.length === 0) R.fail(`${where}: TXT values are non-empty strings`);
      if (value.length > 255) R.fail(`${where}: TXT value is longer than 255 characters`);
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(value)) R.fail(`${where}: TXT values cannot hold control characters`);
      const proof = R.VERIFY_RE.exec(value.trim());
      if (proof && R.fqdnOf(sub, zone) !== `_vercel.${proof[1].toLowerCase()}`) {
        R.fail(
          `${where}: this Vercel proof verifies "${proof[1]}", so it counts on "_vercel.${proof[1].toLowerCase()}" and nowhere else`,
        );
      }
      return value;
    });
  }
  if (raw.MX !== undefined) {
    if (!list("MX")) R.fail(`${where}: records.MX must be an array`);
    out.MX = raw.MX.map((mx) => {
      if (!R.isPlainObject(mx)) R.fail(`${where}: MX entries look like { "priority": 10, "target": "mx.example.com" }`);
      if (!Number.isInteger(mx.priority) || mx.priority < 0 || mx.priority > 65535) {
        R.fail(`${where}: MX priority must be a whole number from 0 to 65535`);
      }
      if (!R.validTarget(mx.target)) R.fail(`${where}: MX target "${mx.target}" is not a public hostname`);
      return { priority: mx.priority, target: mx.target };
    });
  }
  if (raw.NS !== undefined) {
    if (!list("NS")) R.fail(`${where}: records.NS must be an array`);
    out.NS = raw.NS.map((value) => {
      if (!R.validTarget(value)) R.fail(`${where}: "${value}" is not a public nameserver name`);
      return value;
    });
  }
  if (raw.SRV !== undefined) {
    if (!list("SRV")) R.fail(`${where}: records.SRV must be an array`);
    out.SRV = raw.SRV.map((srv) => {
      const range = (n) => Number.isInteger(n) && n >= 0 && n <= 65535;
      const ok = R.isPlainObject(srv) && range(srv.priority) && range(srv.weight) && range(srv.port) && R.validTarget(srv.target);
      if (!ok) {
        R.fail(`${where}: SRV entries look like { "priority": 0, "weight": 5, "port": 25565, "target": "mc.example.com" }, all numbers 0-65535`);
      }
      return srv;
    });
  }
  if (raw.CAA !== undefined) {
    if (!list("CAA")) R.fail(`${where}: records.CAA must be an array`);
    out.CAA = raw.CAA.map((caa) => {
      const ok = R.isPlainObject(caa) && (caa.flag === 0 || caa.flag === 128) &&
        ["issue", "issuewild", "iodef"].includes(caa.tag) &&
        typeof caa.value === "string" && caa.value.length > 0 && caa.value.length <= 255;
      if (!ok) {
        R.fail(`${where}: CAA entries look like { "flag": 0, "tag": "issue", "value": "letsencrypt.org" } (flag 0 or 128, tag issue|issuewild|iodef)`);
      }
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(caa.value)) R.fail(`${where}: CAA values cannot hold control characters`);
      if (caa.tag !== "iodef" && /[/\s]/.test(caa.value)) {
        R.fail(`${where}: a CAA "${caa.tag}" value is a bare domain like "letsencrypt.org", not a URL`);
      }
      return caa;
    });
  }
  if (raw.PTR !== undefined) {
    if (!list("PTR")) R.fail(`${where}: records.PTR must be an array`);
    out.PTR = raw.PTR.map((value) => {
      if (!R.validTarget(value)) R.fail(`${where}: "${value}" is not a public hostname`);
      return value;
    });
  }

  if (R.isApex(sub) && out.CNAME !== undefined) R.fail(`${where}: the apex cannot carry a CNAME; use A and AAAA`);
  if (R.isApex(sub) && out.NS !== undefined) R.fail(`${where}: the apex cannot delegate with NS; that delegation belongs to Cloudflare`);

  const exclusive = ["A", "AAAA", "MX", "NS", "SRV", "PTR"].filter((kind) => out[kind]);
  if (out.CNAME !== undefined && exclusive.length > 0) {
    R.fail(`${where}: a CNAME cannot share its name with ${exclusive.join(", ")}`);
  }

  for (const kind of Object.keys(out)) {
    const values = Array.isArray(out[kind]) ? out[kind] : [out[kind]];
    const keys = values.map((value) => {
      if (typeof value === "string") return kind === "TXT" ? value : value.trim().toLowerCase().replace(/\.$/, "");
      return JSON.stringify(value, Object.keys(value).sort());
    });
    if (new Set(keys).size !== keys.length) R.fail(`${where}: records.${kind} repeats a value`);
  }

  if (Object.keys(out).length === 0) R.fail(`${where}: records is empty; remove the key to get the GitHub Pages default`);
  return out;
}

function validateEntry(filename, name, body, policy, author, actor, touched) {
  const file = `domains/${filename}`;
  const where = { file, body };

  for (const key of Object.keys(body)) {
    if (!R.ENTRY_KEYS.has(key)) {
      R.fail(`${file}: unknown key "${key}" (allowed: ${[...R.ENTRY_KEYS].join(", ")})`);
    }
  }

  checkOwner(file, body, author, actor);
  if (touched) checkClaimant(file, body, author, actor);
  const ownerEntry = R.trustedBy(policy, { id: R.ownerOf(body)?.id, username: R.ownerUsername(body) });
  checkName(file, name, policy, Boolean(ownerEntry));

  if (body.repo !== undefined && !R.validRepo(body.repo)) {
    R.fail(`${file}: "repo" must look like github.com/you/project or a full https URL`);
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") R.fail(`${file}: "description" must be a string`);
    if (body.description.length > 200) R.fail(`${file}: "description" is longer than the 200 characters the site shows`);
  }
  if (body.proxied !== undefined && typeof body.proxied !== "boolean") {
    R.fail(`${file}: "proxied" must be true or false`);
  }

  const sub = name.subdomain;
  if (R.isZoneWide(sub) && !R.trustedBy(policy, { username: R.ownerUsername(body) })) {
    R.fail(`${file}: "${sub}" answers for every name in the zone, so a trusted author holds it. Put your record one label deeper`);
  }

  return { file, sub, zone: name.zone, body, records: normalizeRecords(where, sub, name.zone) };
}

function checkBaseClaims(entries) {
  const problems = [];
  const owners = new Map();
  for (const entry of entries) {
    if (R.isZoneWide(entry.sub) || entry.sub.startsWith("*.") || R.isAuxiliary(entry.sub)) continue;
    owners.set(`${entry.zone}/${entry.sub}`, R.ownerKey(entry.body));
  }

  for (const entry of entries) {
    if (!entry.sub.includes(".")) continue;
    const labels = entry.sub.split(".");
    const serviceOnly = entry.records && entry.records.SRV && !["A", "AAAA", "CNAME", "TXT", "MX", "NS", "PTR"].some((k) => entry.records[k]);
    let index = labels[0] === "*" ? 1 : 0;
    if (labels[0] !== "*" && serviceOnly) continue;
    while (index < labels.length - 1 && labels[index].startsWith("_")) index += 1;
    const base = labels.slice(index).join(".");
    if (!base || base === entry.sub) continue;
    if (owners.get(`${entry.zone}/${base}`) !== R.ownerKey(entry.body)) {
      problems.push({ file: entry.file, message: `${entry.file}: "${entry.sub}" needs "${base}" in ${entry.zone} claimed by the same owner first` });
    }
  }
  return problems;
}

function checkSharedTargets(entries) {
  const problems = [];
  const seen = new Map();

  for (const entry of entries) {
    if (!entry.records) continue;
    const targets = [];
    if (entry.records.CNAME) targets.push(["CNAME", entry.records.CNAME]);
    for (const ip of entry.records.A || []) targets.push(["A", ip]);
    for (const ip of entry.records.AAAA || []) targets.push(["AAAA", ip]);

    for (const [kind, value] of targets) {
      const key = `${entry.zone}/${kind}/${String(value).toLowerCase().replace(/\.$/, "")}`;
      const held = seen.get(key);
      if (!held) {
        seen.set(key, entry);
        continue;
      }
      if (R.ownerKey(held.body) === R.ownerKey(entry.body)) continue;
      problems.push({
        file: entry.file,
        message:
          `${entry.file}: records.${kind} "${value}" is also used by ${held.sub}.${held.zone} under a different owner. ` +
          `Two names cannot serve one site, so point this at your own host`,
      });
    }
  }
  return problems;
}

function checkScope(problems, files, actor, author, policy) {
  if (!files) return;
  const push = (message, file = null) => problems.push({ file, message });
  const touches = (file, prefixes) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix));
  const claims = files.filter((f) => f.path.startsWith("domains/"));

  if (!author) {
    if (claims.length > CLAIM_LIMIT) {
      push(`one pull request changes ${claims.length} files under domains/; a claim is one entry, plus its _vercel sidecar`);
    }
    return;
  }

  if (!actor) {
    for (const { path: file } of files) {
      if (file.startsWith("domains/")) continue;
      if (DOCS.has(file) || file.endsWith(".md")) continue;
      if (touches(file, POLICY_PATHS) || touches(file, CODE_PATHS) || touches(file, CI_PATHS) || file === "CODEOWNERS") {
        push(`${file}: only a trusted author can change this. A claim pull request touches its own domains/<name>.<zone>.json and nothing else`);
      } else {
        push(`${file}: a claim pull request adds one file under domains/, or fixes a typo in the documentation`);
      }
    }
    if (claims.length > CLAIM_LIMIT) {
      push(`one pull request changes ${claims.length} files under domains/; a claim is one entry, plus its _vercel sidecar`);
    }
  } else if (!actor.admin) {
    for (const { path: file } of files) {
      if (file === "registry/trusted.json") push("registry/trusted.json: only an admin can change the trusted list");
    }
  }

  if (actor) return;

  const holds = (entryBody) => {
    const owner = R.ownerOf(entryBody);
    if (!owner) return null;
    if (Number.isInteger(owner.id) && author.id) return owner.id === author.id;
    const username = R.ownerUsername(entryBody);
    if (username && author.username) return username === author.username.toLowerCase();
    // Nothing comparable, so this rule cannot clear the author either.
    return null;
  };

  for (const { status, path: file } of claims) {
    if (!file.endsWith(".json")) continue;
    const previous = baseFile(file);
    if (status === "D") {
      if (previous === null) continue;
      let before;
      try {
        before = JSON.parse(previous);
      } catch {
        continue;
      }
      if (holds(before) === false) {
        push(`${file}: this name belongs to "${R.ownerLabel(before)}"; releasing it is their call or a trusted author's`);
      }
      continue;
    }
    if (previous === null) continue;

    let before;
    try {
      before = JSON.parse(previous);
    } catch {
      continue;
    }
    if (holds(before) === false) {
      push(`${file}: this entry belongs to "${R.ownerLabel(before)}", so only they or a trusted author can change it`);
      continue;
    }
    if (!fs.existsSync(path.join(R.ROOT, file))) continue;

    let after;
    try {
      after = JSON.parse(fs.readFileSync(path.join(R.ROOT, file), "utf8"));
    } catch {
      continue;
    }
    const wasKey = R.ownerKey(before);
    const nowKey = R.ownerKey(after);
    if (wasKey && nowKey && wasKey !== nowKey) {
      push(`${file}: owner moves from "${R.ownerLabel(before)}" to "${R.ownerLabel(after)}"; a claim does not change hands through a pull request`);
    }
  }
}

function report(problems, verified, warnings) {
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, verified, problems, warnings }, null, 2)}\n`);
  } else {
    for (const warning of warnings) console.error(`validate: warning: ${warning.message}`);
    for (const problem of problems) console.error(`validate: ${problem.message}`);
    if (problems.length === 0) console.log(`validate: ${verified} entr${verified === 1 ? "y" : "ies"} verified`);
  }
  if (problems.length > 0) process.exit(1);
}

function main() {
  const problems = [];
  const warnings = [];
  let policy;

  try {
    policy = R.loadPolicy();
  } catch (err) {
    if (!(err instanceof R.RegistryError)) throw err;
    policy = null;
    problems.push({ file: null, message: err.message });
  }

  checkLayout(problems);

  const author = R.currentAuthor();
  const actor = policy ? R.trustedBy(policy, author) : null;
  const changed = changedFiles();
  const touched = changed === null ? null : new Set(changed.map((entry) => entry.path));

  if (policy) {
    try {
      checkPolicyChange(problems, policy, basePolicy(), actor, author);
    } catch (err) {
      if (!(err instanceof R.RegistryError)) throw err;
      problems.push({ file: null, message: err.message });
    }
  }

  const entries = [];
  if (policy && fs.existsSync(R.DOMAINS_DIR)) {
    for (const { filename, full } of R.loadClaims()) {
      const name = R.parseClaimFile(filename, policy.zones);
      if (!name) {
        problems.push({
          file: `domains/${filename}`,
          message: `domains/${filename}: the name must be <subdomain>.<zone>.json, for example jane.${policy.zones[0]}.json or @.${policy.zones[0]}.json`,
        });
        continue;
      }

      const stat = fs.lstatSync(full);
      if (!stat.isFile()) {
        problems.push({ file: `domains/${filename}`, message: `domains/${filename}: entries are regular files, never a symlink` });
        continue;
      }
      if (stat.size > R.MAX_FILE_BYTES) {
        problems.push({ file: `domains/${filename}`, message: `domains/${filename}: file is larger than ${R.MAX_FILE_BYTES} bytes` });
        continue;
      }
      if (filename !== R.claimFile(name.subdomain, name.zone)) {
        problems.push({ file: `domains/${filename}`, message: `domains/${filename}: the filename does not round-trip to the same name` });
        continue;
      }

      let body;
      try {
        body = R.readJson(full);
      } catch (err) {
        if (!(err instanceof R.RegistryError)) throw err;
        problems.push({ file: `domains/${filename}`, message: err.message });
        continue;
      }
      if (!R.isPlainObject(body)) {
        problems.push({ file: `domains/${filename}`, message: `domains/${filename}: an entry is one JSON object, not an array or a bare value` });
        continue;
      }

      try {
        // With no readable change set there is nothing to match against, so the
        // claimant check steps aside rather than guessing.
        const isTouched = touched !== null && touched.has(`domains/${filename}`);
        entries.push(validateEntry(filename, name, body, policy, author, actor, isTouched));
      } catch (err) {
        if (!(err instanceof R.RegistryError)) throw err;
        problems.push({ file: `domains/${filename}`, message: err.message });
      }
    }
  }

  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.zone}/${entry.sub}`;
    if (seen.has(key)) {
      problems.push({ file: entry.file, message: `${entry.file}: "${entry.sub}" is already claimed in ${entry.zone}` });
    }
    seen.set(key, entry);
  }

  problems.push(...checkBaseClaims(entries));
  problems.push(...checkSharedTargets(entries));

  try {
    checkScope(problems, changedFiles(), actor, author);
  } catch (err) {
    if (!(err instanceof R.RegistryError)) throw err;
    problems.push({ file: null, message: err.message });
  }

  report(problems, entries.length, warnings);
}

if (require.main === module) main();

module.exports = { validateEntry, checkScope, checkBaseClaims, checkSharedTargets, normalizeRecords };
