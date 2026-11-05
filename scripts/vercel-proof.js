#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DOMAINS_DIR = path.join(ROOT, "domains");
const PROOF_RE = /^vc-domain-verify=([^,\s]+),([0-9A-Za-z_-]+)$/;

function parseArgs(argv) {
  const out = { name: "", proof: "", token: "", remove: false, list: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--name") out.name = next();
    else if (arg === "--proof") out.proof = next();
    else if (arg === "--token") out.token = next();
    else if (arg === "--remove") out.remove = true;
    else if (arg === "--list") out.list = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return out;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/vercel-proof.js --list",
    "  node scripts/vercel-proof.js --name <label> --proof \"vc-domain-verify=<fqdn>,<token>\"",
    "  node scripts/vercel-proof.js --name <label> --token <token>",
    "  node scripts/vercel-proof.js --name <label> --remove",
    "",
    "Creates domains/_vercel.<label>.<zone>.json, the sidecar that carries the",
    "Vercel ownership TXT for a name that is already granted. Vercel shows both",
    "halves of the proof in the project's Domains panel, so paste either the whole",
    "line (--proof) or just the token (--token).",
  ].join("\n");
}

function readEntry(label) {
  const files = fs.existsSync(DOMAINS_DIR) ? fs.readdirSync(DOMAINS_DIR) : [];
  const matches = files.filter((name) => {
    if (!name.endsWith(".json")) return false;
    return name.slice(0, -5).split(".")[0] === label;
  });
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new Error(`"${label}" matches ${matches.join(", ")}; pass a zone-qualified label`);
  const file = path.join(DOMAINS_DIR, matches[0]);
  return { file, entry: JSON.parse(fs.readFileSync(file, "utf8")) };
}

function sidecarPath(entry) {
  return path.join(DOMAINS_DIR, `_vercel.${entry.subdomain}.${entry.domain}.json`);
}

function listSidecars() {
  const files = fs.existsSync(DOMAINS_DIR) ? fs.readdirSync(DOMAINS_DIR).sort() : [];
  const rows = files
    .filter((name) => name.startsWith("_vercel.") && name.endsWith(".json"))
    .map((name) => {
      const entry = JSON.parse(fs.readFileSync(path.join(DOMAINS_DIR, name), "utf8"));
      const proof = (entry.records && entry.records.TXT) || [];
      return { file: name, owner: entry.owner, proofs: proof };
    });
  if (rows.length === 0) {
    console.log("no Vercel proof sidecars in domains/");
    return;
  }
  for (const row of rows) {
    console.log(row.file);
    console.log(`  owner  ${row.owner}`);
    row.proofs.forEach((proof) => console.log(`  proof  ${proof}`));
  }
}

function runCheck() {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "validate.js")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  const relevant = output.split("\n").filter((line) => /problem|_vercel|error/i.test(line));
  console.log(relevant.length > 0 ? relevant.join("\n") : output.split("\n").slice(-1)[0]);
  return result.status === 0;
}

function resolveProof(args, fqdn) {
  const raw = args.proof || (args.token ? `vc-domain-verify=${fqdn},${args.token}` : "");
  if (!raw) throw new Error("pass --proof (the whole TXT line) or --token (just the part after the comma)");
  const match = PROOF_RE.exec(raw.trim());
  if (!match) throw new Error(`"${raw}" is not a Vercel proof; it must look like vc-domain-verify=${fqdn},<token>`);
  if (match[1].toLowerCase() !== fqdn) {
    throw new Error(`this proof verifies "${match[1]}", but the registry name is "${fqdn}"; one proof per name`);
  }
  return `vc-domain-verify=${fqdn},${match[2]}`;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`vercel-proof: ${error.message}\n\n${usage()}`);
    process.exit(1);
  }

  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.list) {
    listSidecars();
    return;
  }
  if (!args.name) {
    console.error(`vercel-proof: --name is required\n\n${usage()}`);
    process.exit(2);
  }
  if (args.name.startsWith("_")) throw new Error(`"${args.name}" is already an auxiliary name; name the claim it serves`);

  const found = readEntry(args.name);
  if (!found) throw new Error(`no domains/${args.name}.<zone>.json entry exists, claim the name first`);
  const { entry } = found;
  const fqdn = `${entry.subdomain}.${entry.domain}`;
  const target = sidecarPath(entry);
  const relative = `domains/${path.basename(target)}`;

  if (args.remove) {
    if (!fs.existsSync(target)) {
      console.log(`vercel-proof: ${relative} does not exist, nothing to remove`);
      return;
    }
    if (!args.dryRun) fs.unlinkSync(target);
    console.log(`${args.dryRun ? "would remove" : "removed"} ${relative}`);
    console.log(`the ${fqdn} claim in ${path.basename(found.file)} is untouched; delete the TXT only after Vercel reads Valid Configuration`);
    return;
  }

  const proof = resolveProof(args, fqdn);
  const body = {
    domain: entry.domain,
    subdomain: `_vercel.${entry.subdomain}`,
    owner: entry.owner,
    description: `Vercel ownership proof for ${fqdn}. Temporary: removed once the project reads Valid Configuration.`,
    records: { TXT: [proof] },
    proxied: false,
  };

  if (args.dryRun) {
    console.log(`would write ${relative}\n${JSON.stringify(body, null, 2)}`);
    return;
  }

  if (fs.existsSync(target)) {
    const existing = JSON.parse(fs.readFileSync(target, "utf8"));
    const proofs = new Set([...((existing.records && existing.records.TXT) || []), proof]);
    body.records.TXT = [...proofs];
  }

  fs.writeFileSync(target, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${relative}`);
  console.log(`  owner  ${body.owner}`);
  body.records.TXT.forEach((line) => console.log(`  proof  ${line}`));
  console.log("");

  if (!runCheck()) {
    console.error("\nvercel-proof: validation failed; fix the report above before opening the pull request");
    process.exit(1);
  }

  console.log("");
  console.log("Next:");
  console.log(`  1. commit ${path.basename(found.file)} and ${relative} together`);
  console.log("  2. open the pull request; a maintainer pushes it to Cloudflare on merge");
  console.log(`  3. in Vercel press Verify on ${fqdn}, then run --name ${entry.subdomain} --remove`);
}

try {
  main();
} catch (error) {
  console.error(`vercel-proof: ${error.message}`);
  process.exit(1);
}
