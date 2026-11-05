#!/usr/bin/env node

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { renderReport } = require("./render-report.js");

const ROOT = path.resolve(__dirname, "..");

function runNode(script, args, env) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function parseOwnerMismatches(stderr) {
  const problems = [];
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2);
    const match = /^(.+?):\s+owner "(.+?)" does not match the PR author "(.+?)"/.exec(body);
    if (!match) continue;
    const file = match[1].replace(/\\/g, "/").split("/").pop();
    problems.push({
      file,
      message:
        `${file}: owner "${match[2]}" does not match the PR author "${match[3]}"; ` +
        `"owner" must be your own GitHub username, or the owner has to open the PR`,
    });
  }
  return problems;
}

function readChangedFiles() {
  const raw = process.env.CHANGED_FILES || "";
  if (raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((f) => typeof f === "string");
  } catch {
    // Not JSON: the workflow passes one filename per line.
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function main() {
  const changedFiles = readChangedFiles();

  const validation = runNode("validate.js", ["--json"]);
  let report;
  try {
    report = JSON.parse(validation.stdout);
  } catch {
    process.stderr.write("pr-report: validator produced no JSON\n");
    process.exit(1);
  }

  if (process.env.PR_AUTHOR && changedFiles.length > 0) {
    const owners = runNode("verify-owners.js", [], {
      PR_AUTHOR: process.env.PR_AUTHOR,
      CHANGED_FILES: JSON.stringify(changedFiles),
    });
    if (owners.code === 1) {
      const extra = parseOwnerMismatches(owners.stderr);
      if (extra.length > 0) {
        report.problems.push(...extra);
        report.ok = false;
      } else {
        const firstLine = owners.stderr.split("\n").find((l) => l.trim().length > 0) || "owner check failed";
        report.problems.push({ file: changedFiles[0] || null, message: firstLine.trim() });
        report.ok = false;
      }
    }
  }

  const markdown = renderReport({
    report,
    prAuthor: process.env.PR_AUTHOR || "",
    prNumber: process.env.PR_NUMBER || "",
  });

  process.stdout.write(markdown);
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { parseOwnerMismatches, readChangedFiles };
