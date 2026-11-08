#!/usr/bin/env node

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const JSON_MODE = process.argv.includes("--json");

const CLAIM_FILENAME_RE = /^(?:@|\*|[a-z0-9_*][a-z0-9._*-]*)\.([a-z0-9.-]+)\.json$/;

/** Directories a claim PR must not touch at all. */
const CODE_PATHS = ["scripts/", "test/", "dnsconfig.js", "package.json", "package-lock.json"];
/** Directories only a maintainer may touch. */
const MAINTAINER_PATHS = ["domains/_meta.json", "domains/SCHEMA.json", ".github/", "CODEOWNERS"];
/** Files whose change is always allowed, whoever opens the PR. */
const DOC_PATHS = ["README.md", "CONTRIBUTING.md", "AGENTS.md", "LICENSE", ".gitignore", ".gitattributes"];

const MAX_FILES_PER_CLAIM_PR = 4;

class FormatError extends Error {}

function git(args) {
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

function baseRef() {
  return process.env.GITHUB_BASE_REF || "main";
}

function changedFiles() {
  const fromEnv = process.env.CHANGED_FILES;
  if (fromEnv && fromEnv.trim().length > 0) {
    let list;
    try {
      const parsed = JSON.parse(fromEnv);
      list = Array.isArray(parsed) ? parsed : null;
    } catch {
      list = null;
    }
    if (list === null) list = fromEnv.split("\n").map((line) => line.trim());
    return list
      .filter((f) => typeof f === "string" && f.length > 0)
      .map((f) => ({ status: "?", path: f.replace(/\\/g, "/") }));
  }

  const explicit = process.argv.indexOf("--files");
  if (explicit !== -1) {
    return process.argv
      .slice(explicit + 1)
      .filter((a) => !a.startsWith("--"))
      .map((f) => ({ status: "?", path: f.replace(/\\/g, "/") }));
  }

  const base = baseRef();
  const ranges = [`origin/${base}...HEAD`, `${base}...HEAD`];
  for (const range of ranges) {
    const out = git(["diff", "--no-renames", "--name-status", range]);
    if (out === null) continue;
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [status, ...rest] = line.split(/\s+/);
        return { status: status[0], path: rest.join(" ").replace(/\\/g, "/") };
      })
      .filter((entry) => entry.path.length > 0);
  }
  return null;
}

function isClaimFile(file) {
  if (!file.startsWith("domains/")) return false;
  const rest = file.slice("domains/".length);
  if (rest.includes("/")) return false;
  const base = path.basename(rest);
  if (["_meta.json", "_example.json", "SCHEMA.json"].includes(base)) return false;
  return base.endsWith(".json");
}

function matchesMaintainerPath(file) {
  return MAINTAINER_PATHS.some((prefix) => file === prefix || file.startsWith(prefix));
}

function matchesCodePath(file) {
  return CODE_PATHS.some((prefix) => file === prefix || file.startsWith(prefix));
}

/**
 * @param {Array<{status: string, path: string}>} files
 * @param {{isMaintainer: boolean, scope?: boolean, root?: string}} context
 * @returns {Array<{file: (string|null), message: string}>}
 *
 * `scope` says whether the change is being judged as somebody's pull request.
 * The rules it gates all ask "may this author touch this path", which needs an
 * author to answer; a local run has none, so it checks the file rules only.
 */
function checkFormat(files, context) {
  const root = context.root || ROOT;
  const scoped = context.scope !== false;
  const problems = [];
  const push = (message, file) => problems.push({ file: file || null, message });

  if (files.length === 0) return problems;

  const claimFiles = files.filter((f) => isClaimFile(f.path));
  const deletedClaims = claimFiles.filter((f) => f.status === "D");

  for (const { status, path: file } of files) {
    if (!scoped) continue;
    if (!file.startsWith("domains/") && !matchesMaintainerPath(file) && !matchesCodePath(file)) {
      if (!DOC_PATHS.includes(file) && !/^docs\//.test(file)) {
        push(
          `${file}: a pull request may only add a file under domains/, or update the documentation. ` +
            `Move this change to its own pull request.`,
          file,
        );
      }
      continue;
    }

    if (matchesMaintainerPath(file) && !context.isMaintainer) {
      push(
        `${file}: only a maintainer can change this file. A claim PR touches its own ` +
          `domains/<name>.<zone>.json and nothing else.`,
        file,
      );
      continue;
    }

    if (matchesCodePath(file) && !context.isMaintainer) {
      push(
        `${file}: only a maintainer can change the validator, the DNS config or the test suite. ` +
          `Open a separate issue or pull request for that, and keep this one to your claim.`,
        file,
      );
    }
  }

  // A claim PR is one or two files: the claim itself, plus the Vercel sidecar
  // that proves ownership of it. Anything wider is a different kind of change.
  if (scoped && !context.isMaintainer && claimFiles.length > MAX_FILES_PER_CLAIM_PR) {
    push(
      `this pull request touches ${claimFiles.length} files under domains/; a claim PR adds one ` +
        `entry (plus its _vercel.<name> sidecar if Vercel asked for one). ` +
        `Split the rest into their own pull requests.`,
      null,
    );
  }

  for (const { path: file } of claimFiles) {
    const base = path.basename(file);
    if (!CLAIM_FILENAME_RE.test(base)) {
      push(
        `${file}: the filename must be <subdomain>.<zone>.json, for example jane.is-a.ceo.json, ` +
          `@.is-a.ceo.json or _vercel.jane.is-a.ceo.json`,
        file,
      );
      continue;
    }
    if (!fs.existsSync(path.join(root, file))) continue;

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    } catch {
      // validate.js reports the parse failure with the parser's own message.
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const expected = `${parsed.subdomain}.${parsed.domain}.json`;
    if (typeof parsed.subdomain === "string" && typeof parsed.domain === "string" && base !== expected) {
      push(`${file}: the file claims "${parsed.subdomain}" in "${parsed.domain}", so it must be named "${expected}"`, file);
    }

    // A convention the reviewer reads without thinking: one entry per file,
    // two-space indent, a final newline. Key order is not enforced, because it
    // is taste rather than a readable rule and every existing entry differs.
    const text = fs.readFileSync(path.join(root, file), "utf8");
    if (/\t/.test(text)) {
      push(`${file}: use two spaces for indentation, not tabs`, file);
    }
    if (!text.endsWith("\n")) {
      push(`${file}: end the file with a newline`, file);
    }
  }

  if (context.isMaintainer) return problems;

  for (const { path: file } of deletedClaims) {
    push(
      `${file}: deleting a name is a maintainer action. If you want to release your own ` +
        `subdomain, ask a maintainer, or open the pull request from the account named in "owner".`,
      file,
    );
  }

  return problems;
}

function maintainerList() {
  const metaPath = path.join(ROOT, "domains", "_meta.json");
  if (!fs.existsSync(metaPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const meta = raw._meta || raw;
    const list = Array.isArray(meta.maintainers) ? meta.maintainers : [];
    return list.map((m) => String(m).trim().replace(/^@/, "").toLowerCase());
  } catch {
    return [];
  }
}

function isMaintainerAuthor() {
  const author = String(process.env.PR_AUTHOR || "").trim().replace(/^@/, "").toLowerCase();
  if (!author) return false;
  return maintainerList().includes(author);
}

/**
 * Whether this run knows whose pull request it is judging. In CI the workflow
 * passes PR_AUTHOR; a local `npm run verify` on a branch passes nothing, and
 * the scope rules cannot answer "is this author allowed to touch this path"
 * without an author, so they are skipped rather than guessed.
 */
function knowsAuthor() {
  return String(process.env.PR_AUTHOR || "").trim().length > 0;
}

function report(problems, scoped) {
  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
  } else if (problems.length === 0) {
    console.log(
      scoped
        ? "check-format: the change follows the repository layout"
        : "check-format: the changed entries follow the repository layout " +
          "(no PR_AUTHOR, so the per-author scope rules were not applied)",
    );
  } else {
    console.error("check-format: this pull request does not follow the repository layout.\n");
    for (const problem of problems) console.error(`  - ${problem.message}`);
    console.error(
      "\nA claim is one file: domains/<subdomain>.<zone>.json, copied from domains/_example.json. " +
        "See CONTRIBUTING.md.",
    );
  }
  if (problems.length > 0) process.exit(1);
}

function main() {
  const files = changedFiles();
  if (files === null) {
    report(
      [
        {
          file: null,
          message:
            `check-format: could not read the changed files (git diff against ${baseRef()} failed). ` +
            `Fetch the base branch, then run again.`,
        },
      ],
      true,
    );
    return;
  }
  const scoped = knowsAuthor();
  report(checkFormat(files, { isMaintainer: isMaintainerAuthor(), scope: scoped }), scoped);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (error instanceof FormatError) {
      console.error(`check-format: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

module.exports = { checkFormat, changedFiles, isClaimFile, CLAIM_FILENAME_RE };
