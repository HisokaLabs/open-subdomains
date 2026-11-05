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

function loadMaintainers() {
  if (!fs.existsSync(META_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    const meta = parsed._meta || parsed;
    return Array.isArray(meta.maintainers)
      ? meta.maintainers.map((s) => normalizeUsername(s)).filter(Boolean)
      : [];
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

function changedFiles() {
  if (process.env.CHANGED_FILES) {
    try {
      const parsed = JSON.parse(process.env.CHANGED_FILES);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (f) => typeof f === "string" && f.toLowerCase().endsWith(".json") && !isReservedFile(f)
        );
      }
    } catch {
      return process.env.CHANGED_FILES.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.toLowerCase().endsWith(".json") && !isReservedFile(l));
    }
  }

  const base = process.env.GITHUB_BASE_REF || "main";
  const diffStrategies = [
    ["diff", "--name-only", "--diff-filter=ACMR", `origin/${base}...HEAD`, "--", "domains"],
    ["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`, "--", "domains"],
    ["diff", "--name-only", "--diff-filter=ACMR", "HEAD~1...HEAD", "--", "domains"],
    ["status", "--porcelain", "--", "domains"],
  ];

  for (const args of diffStrategies) {
    const output = runGit(args);
    if (output !== null) {
      const lines = output
        .split("\n")
        .map((l) => (l.length >= 3 && /^[ MADRCU?!]{1,2}\s/.test(l) ? l.slice(3) : l).trim())
        .filter((l) => l.toLowerCase().endsWith(".json") && !isReservedFile(l));
      if (lines.length > 0) return lines;
    }
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
  const maintainers = loadMaintainers();
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

  for (const file of files) {
    const full = path.resolve(ROOT, file);
    if (!fs.existsSync(full)) continue;

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

    const baseEntry = readFromBase(file, process.env.GITHUB_BASE_REF || "main");
    if (baseEntry) {
      const previous = baseOwnerUsername(baseEntry);
      const current = baseOwnerUsername(parsed);
      if (previous && current && previous !== current) {
        takeovers.push(
          `${file}: owner changes from "${previous}" to "${current}"; an existing claim cannot change hands ` +
            `through a pull request. Ask a maintainer to transfer it`
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

  if (takeovers.length > 0) {
    console.error("verify-owners: an existing subdomain cannot be reassigned by rewriting its file.");
    takeovers.forEach((t) => console.error(`  - ${t}`));
    process.exit(1);
  }

  console.log(`verify-owners: ${files.length} file(s) verified against PR author "${prAuthor}"`);
}

main();
