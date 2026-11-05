#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "<!-- registry-validator -->";
const MAX_PROBLEMS_PER_FILE = 12;

const FIELD_HINTS = [
  { test: /missing "domain"/, key: "domain" },
  { test: /missing "subdomain"/, key: "subdomain" },
  { test: /"owner" must be a plain username string/, key: "owner" },
  { test: /missing "owner"/, key: "owner" },
  { test: /"records" must be an object/, key: "records" },
  { test: /unknown key/, key: "keys" },
  { test: /file must be named/, key: "filename" },
  { test: /cannot coexist with/, key: "cname" },
  { test: /without a \.json extension/, key: "extension" },
  { test: /invalid JSON/, key: "json" },
  { test: /already has .* one subdomain per person/, key: "quota" },
  { test: /is reserved by the registry|is blocked by the registry/, key: "reserved" },
  { test: /is a zone-wide name, so maintainers hold it/, key: "zone-wide" },
  { test: /keeps those names unclaimed/, key: "reserved-word" },
  { test: /not a public IPv4|not a public IPv6/, key: "private-ip" },
  { test: /is not a valid public CNAME target|not a public hostname/, key: "target" },
  { test: /needs .* claimed by the same owner/, key: "base" },
];

function subdomainFromFile(file) {
  if (typeof file !== "string") return "";
  const base = path.basename(file).replace(/\.json$/i, "");
  const dot = base.indexOf(".is-a.ceo");
  return dot > 0 ? base.slice(0, dot) : base;
}

function exampleFor(subdomain) {
  const label = subdomain || "mc";
  return [
    "{",
    '  "$schema": "./SCHEMA.json",',
    '  "domain": "is-a.ceo",',
    `  "subdomain": "${label}",`,
    '  "owner": "your-github-username",',
    '  "repo": "github.com/your-github-username/your-repo",',
    '  "description": "One line describing what runs here.",',
    '  "records": {',
    '    "CNAME": "your-project.pages.dev"',
    "  }",
    "}",
  ].join("\n");
}

function hintsFor(problems) {
  const kinds = new Set();
  for (const problem of problems) {
    for (const hint of FIELD_HINTS) {
      if (hint.test.test(problem.message)) kinds.add(hint.key);
    }
  }
  return kinds;
}

const NOTES = {
  keys:
    "Only these keys are read: `$schema`, `_about`, `domain`, `subdomain`, `owner`, " +
    "`email`, `proxied`, `repo`, `description`, `records`. Anything else is a typo the site would silently ignore.",
  filename:
    "The filename must be exactly `<subdomain>.<zone>.json`, so the diff names the full record.",
  extension:
    "A registry file that does not end in `.json` is invisible to the validator and to `dnsconfig.js`, so the name is never pushed.",
  cname:
    "A `CNAME` cannot share its name with `A`, `AAAA`, `MX`, `NS`, `SRV`, or `PTR`. Use `A`/`AAAA` against your own IPs, or point the CNAME at the host that terminates the traffic.",
  quota:
    "One subdomain per person per zone. Close this PR if you already hold one, or pick a different zone.",
  reserved:
    "Reserved and blocked labels are never granted. Anything that looks like impersonation or phishing is blocked outright.",
  "zone-wide":
    "`@`, a bare `*`, and a bare underscore name (`_acme-challenge`, `_vercel`, `_dmarc`) change the whole zone: " +
    "a root `_acme-challenge` can answer a DNS-01 challenge for `*.is-a.ceo`, and a root `_vercel` is the ownership " +
    "proof Vercel asks for. Only maintainers hold those. Your own verification record belongs one label deeper, " +
    "e.g. `_vercel.yourname`.",
  "reserved-word":
    "Some names are refused by the kind of word they are rather than by a list. Pronouns (`me`, `we`, `they`, `you`), articles (`the`, `this`), and grammar words describe the reader, not you, so they are never granted. Pick the GitHub handle the record points at.",
  "private-ip":
    "Records must be reachable from the public internet. Loopback, RFC 1918, link-local and CGNAT addresses are rejected.",
  target:
    "`CNAME`, `MX`, `NS`, `SRV` and `PTR` targets must be real public hostnames, without a scheme or a path.",
  base:
    "A wildcard (`*.base`) or an underscore record (`_acme-challenge.base`) can only sit on a name you already hold.",
  json:
    "The file failed to parse. A missing comma, a trailing comma, or smart quotes are the usual causes.",
  owner:
    "`owner` is the GitHub username of the person opening the PR, as a plain string.",
};

function renderSection(entry) {
  const lines = [];
  lines.push(entry.file ? `### \`${entry.file}\`` : "### Repository");
  lines.push("");
  for (const problem of entry.problems.slice(0, MAX_PROBLEMS_PER_FILE)) {
    const text =
      entry.file && problem.message.startsWith(`${entry.file}: `)
        ? problem.message.slice(entry.file.length + 2)
        : problem.message;
    lines.push(`- ${text}`);
  }
  if (entry.problems.length > MAX_PROBLEMS_PER_FILE) {
    lines.push(`- ...and ${entry.problems.length - MAX_PROBLEMS_PER_FILE} more`);
  }
  lines.push("");
  return lines;
}

function renderNotes(kinds) {
  const picked = [...kinds].filter((kind) => NOTES[kind]);
  if (picked.length === 0) return [];
  const lines = [];
  for (const kind of picked) {
    lines.push(`- ${NOTES[kind]}`);
  }
  return lines;
}

function renderReport({ report, prAuthor, prNumber }) {
  const problems = Array.isArray(report.problems) ? report.problems : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const verified = Array.isArray(report.verified) ? report.verified : [];
  const ok = report.ok === true && problems.length === 0;

  const lines = [];
  lines.push(MARKER);
  lines.push("");

  if (ok) {
    const heading = warnings.length > 0 ? "## Registry check passed, one change needed before merge" : "## Registry check passed";
    lines.push(heading);
    lines.push("");
    lines.push(`${verified.length} entr${verified.length === 1 ? "y" : "ies"} verified against the schema.`);
    if (warnings.length > 0) {
      lines.push("");
      lines.push("### Fix this before a maintainer merges");
      lines.push("");
      for (const warning of warnings) {
        lines.push(`- ${warning.message}`);
      }
      lines.push("");
      lines.push(
        "The validator accepts it, so this check stays green, but the DNS push after merge will fail " +
          "and the record will not be applied."
      );
      lines.push("");
      return `${lines.join("\n")}`;
    }
    lines.push("");
    lines.push("A maintainer still has to review. Nothing else is needed from you.");
    lines.push("");
    return `${lines.join("\n")}`;
  }

  lines.push("## Registry check failed");
  lines.push("");
  lines.push(
    `${problems.length} problem${problems.length === 1 ? "" : "s"} found. ` +
      "Fix them in the same pull request; the check re-runs on every push."
  );
  lines.push("");

  const byFile = new Map();
  for (const problem of problems) {
    const key = problem.file || "repository";
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(problem);
  }

  for (const [file, list] of byFile) {
    lines.push(...renderSection({ file: file === "repository" ? null : file, problems: list }));
  }

  const kinds = hintsFor(problems);
  const notes = renderNotes(kinds);
  if (notes.length > 0) {
    lines.push("### Why");
    lines.push("");
    lines.push(...notes);
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push("### Also worth fixing");
    lines.push("");
    for (const warning of warnings) {
      lines.push(`- ${warning.message}`);
    }
    lines.push("");
  }

  const firstFile = problems.find((p) => p.file && p.file !== "repository");
  const firstLabel = firstFile ? subdomainFromFile(firstFile.file) : "";
  const labelIsTheProblem = kinds.has("reserved-word") || kinds.has("reserved");
  const label = labelIsTheProblem ? "" : firstLabel;
  lines.push("### What a valid file looks like");
  lines.push("");
  lines.push("```json");
  lines.push(exampleFor(label));
  lines.push("```");
  lines.push("");
  lines.push(
    "Every field is documented in [CONTRIBUTING.md](https://github.com/HisokaLabs/open-subdomains/blob/main/CONTRIBUTING.md) and " +
      "[domains/_example.json](https://github.com/HisokaLabs/open-subdomains/blob/main/domains/_example.json). " +
      "Run `npm run check` and `npm test` locally to see the same verdict before pushing."
  );
  if (prAuthor) {
    lines.push("");
    lines.push(`<sub>Checked for @${prAuthor}${prNumber ? ` on #${prNumber}` : ""}.</sub>`);
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

function main() {
  const args = process.argv.slice(2);
  const inputIndex = args.indexOf("--input");
  const source = inputIndex >= 0 ? args[inputIndex + 1] : null;
  let raw = "";
  if (source) {
    raw = fs.readFileSync(source, "utf8");
  } else {
    raw = fs.readFileSync(0, "utf8");
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`render-report: could not parse validator output: ${err.message}\n`);
    process.exit(1);
  }
  const prAuthor = process.env.PR_AUTHOR || "";
  const prNumber = process.env.PR_NUMBER || "";
  const markdown = renderReport({ report, prAuthor, prNumber });
  const outIndex = args.indexOf("--out");
  if (outIndex >= 0) {
    fs.writeFileSync(args[outIndex + 1], markdown, "utf8");
  } else {
    process.stdout.write(markdown);
  }
}

if (require.main === module) {
  main();
}

module.exports = { renderReport, exampleFor, subdomainFromFile, MARKER };
