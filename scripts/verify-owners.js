#!/usr/bin/env node

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DOMAINS_DIR = path.join(ROOT, "domains");
const META_PATH = path.join(DOMAINS_DIR, "_meta.json");
const RESERVED_FILENAMES = new Set(["_meta.json", "_example.json", "schema.json"]);

function isReservedFile(filename) {
  return RESERVED_FILENAMES.has(path.basename(filename).toLowerCase());
}

function normalizeUsername(value) {
  if (typeof value === "string") {
    return value.trim().replace(/^@/, "").toLowerCase();
  }
  if (value && typeof value === "object") {
    const name = value.username || value.name || value.login;
    if (typeof name === "string") {
      return name.trim().replace(/^@/, "").toLowerCase();
    }
  }
  return "";
}

function getRawOwner(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry.owner === "string") return entry.owner;
  if (entry.owner && typeof entry.owner === "object") {
    return entry.owner.username || entry.owner.name || entry.owner.login || "";
  }
  return "";
}

function maintainersFrom(value) {
  const meta = value && value._meta ? value._meta : value;
  return meta && Array.isArray(meta.maintainers)
    ? meta.maintainers.map((s) => normalizeUsername(s)).filter(Boolean)
    : [];
}

function loadMaintainers(ref) {
  if (!ref) return maintainersFromFile();
  const raw = runGit(["show", `${ref}:domains/_meta.json`]);
  if (raw === null) return maintainersFromFile();
  try {
    return maintainersFrom(JSON.parse(raw));
  } catch {
    return [];
  }
}

function maintainersFromFile() {
  if (!fs.existsSync(META_PATH)) return [];
  try {
    return maintainersFrom(JSON.parse(fs.readFileSync(META_PATH, "utf8")));
  } catch {
    return [];
  }
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

const BASE_REF = process.env.GITHUB_BASE_REF || "main";

function changedFiles() {
  if (process.env.CHANGED_FILES) {
    const text = process.env.CHANGED_FILES;
    let list;
    try {
      const parsed = JSON.parse(text);
      list = Array.isArray(parsed) ? parsed : null;
    } catch {
      list = null;
    }
    if (list === null) list = text.split("\n").map((line) => line.trim());
    return list.filter(
      (f) => typeof f === "string" && f.length > 0 && f.toLowerCase().endsWith(".json") && !isReservedFile(f),
    );
  }

  const base = process.env.GITHUB_BASE_REF || "main";
  const diffStrategies = [
    ["diff", "--no-renames", "--name-only", "--diff-filter=ACMRD", `origin/${base}...HEAD`, "--", "domains"],
    ["diff", "--no-renames", "--name-only", "--diff-filter=ACMRD", `${base}...HEAD`, "--", "domains"],
    ["diff", "--no-renames", "--name-only", "--diff-filter=ACMRD", "HEAD~1...HEAD", "--", "domains"],
  ];

  let answered = false;
  for (const args of diffStrategies) {
    const output = runGit(args);
    if (output === null) continue;
    answered = true;
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => line.toLowerCase().endsWith(".json") && !isReservedFile(line));
    if (lines.length > 0) return lines;
  }

  // No diff could narrow the set down, but git was reachable: the PR is clean.
  if (answered) return [];

  // git itself is unavailable, so fall back to whatever is on disk.
  const status = runGit(["status", "--porcelain", "--", "domains"]);
  if (status !== null && status.trim().length > 0) {
    const lines = status
      .split("\n")
      .map((l) => (l.length >= 3 && /^[ MADRCU?!]{1,2}\s/.test(l) ? l.slice(3) : l).trim())
      .filter((l) => l.toLowerCase().endsWith(".json") && !isReservedFile(l));
    if (lines.length > 0) return lines;
  }

  if (fs.existsSync(DOMAINS_DIR)) {
    return fs
      .readdirSync(DOMAINS_DIR)
      .filter((f) => f.toLowerCase().endsWith(".json") && !isReservedFile(f))
      .map((f) => path.join("domains", f));
  }

  return [];
}

function readFromBase(file, base) {
  const refs = [`origin/${base}`, base];
  for (const ref of refs) {
    const raw = runGit(["show", `${ref}:${file}`]);
    if (raw === null) continue;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function baseOwnerUsername(parsed) {
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const raw = getRawOwner(entry);
    if (raw && raw.trim().length > 0) return normalizeUsername(raw);
  }
  return "";
}

function main() {
  const prAuthor = process.env.PR_AUTHOR;
  if (!prAuthor) {
    console.log("verify-owners: PR_AUTHOR not set, not a pull request, skipping");
    process.exit(0);
  }

  const author = normalizeUsername(prAuthor);
  const maintainers = loadMaintainers(`origin/${BASE_REF}`);
  if (maintainers.includes(author)) {
    console.log(`verify-owners: PR author "${prAuthor}" is a registry maintainer, skipping owner check`);
    process.exit(0);
  }

  const files = changedFiles();
  if (files.length === 0) {
    console.log("verify-owners: no registry files changed by this PR");
    process.exit(0);
  }

  const mismatches = [];
  const takeovers = [];
  const removals = [];

  for (const file of files) {
    const full = path.resolve(ROOT, file);
    if (!fs.existsSync(full)) {
      const baseEntry = readFromBase(file, BASE_REF);
      if (baseEntry) {
        const previous = baseOwnerUsername(baseEntry);
        if (previous && previous !== author) {
          removals.push(
            `${file}: this entry belongs to "${previous}"; only the owner or a maintainer can delete it`
          );
        }
      }
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const rawOwner = getRawOwner(entry);
      if (!rawOwner || rawOwner.trim().length === 0) {
        continue;
      }
      const owner = normalizeUsername(rawOwner);
      if (owner !== author) {
        mismatches.push(`${file}: owner "${rawOwner}" does not match the PR author "${prAuthor}"`);
      }
    }

    const baseEntry = readFromBase(file, BASE_REF);
    if (baseEntry) {
      const previous = baseOwnerUsername(baseEntry);
      const current = baseOwnerUsername(parsed);
      if (previous && current && previous !== current) {
        takeovers.push(
          `${file}: owner changes from "${previous || previousId}" to "${current || currentId}"; ` +
            `an existing claim cannot change hands through a pull request. Ask a maintainer to transfer it`
        );
      }
    }
  }

  if (mismatches.length > 0) {
    console.error("verify-owners: every entry must be owned by the person opening the PR.\n");
    mismatches.forEach((m) => console.error(`  - ${m}`));
    console.error(
      "\nIf you are claiming this subdomain for someone else, ask them to open the PR " +
        "themselves, or set \"owner\" to your own username."
    );
    process.exit(1);
  }

  if (removals.length > 0) {
    console.error("verify-owners: a pull request cannot delete an entry owned by someone else.");
    removals.forEach((r) => console.error(`  - ${r}`));
    process.exit(1);
  }

  if (takeovers.length > 0) {
    console.error("verify-owners: an existing subdomain cannot be reassigned by rewriting its file.");
    takeovers.forEach((t) => console.error(`  - ${t}`));
    process.exit(1);
  }

  console.log(`verify-owners: ${files.length} file(s) verified against PR author "${prAuthor}"`);
}

if (require.main === module) {
  main();
}

module.exports = { normalizeUsername, getRawOwner };
