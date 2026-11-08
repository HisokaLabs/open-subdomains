"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO, "scripts");

const { fold, parseClaimFile, isZoneWide, isAuxiliary, reservedWord } = require(path.join(SCRIPTS, "registry.js"));

function registry(files, zones = ["is-a.ceo"], reserved = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnsconfig-"));
  fs.mkdirSync(path.join(dir, "registry"));
  fs.writeFileSync(path.join(dir, "registry", "zones.json"), JSON.stringify(zones));
  fs.writeFileSync(path.join(dir, "registry", "reserved.json"), JSON.stringify(reserved));
  fs.copyFileSync(path.join(REPO, "dnsconfig.js"), path.join(dir, "dnsconfig.js"));
  fs.mkdirSync(path.join(dir, "domains"));
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, "domains", file), JSON.stringify(content));
  }
  return dir;
}

function load(dir) {
  const zones = {};
  const errors = [];
  const saved = {};
  const names = ["NewRegistrar", "DnsProvider", "NewDnsProvider", "A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV", "CAA", "PTR", "D", "glob", "IGNORE"];

  for (const name of names) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);

  globalThis.NewRegistrar = () => ({});
  globalThis.DnsProvider = () => ({});
  globalThis.NewDnsProvider = () => ({});
  globalThis.A = (name, value, meta) => ["A", name, value, meta];
  globalThis.AAAA = (name, value, meta) => ["AAAA", name, value, meta];
  globalThis.CNAME = (name, value, meta) => ["CNAME", name, value, meta];
  globalThis.TXT = (name, value) => ["TXT", name, value];
  globalThis.MX = (name, priority, target) => ["MX", name, priority, target];
  globalThis.NS = (name, target) => ["NS", name, target];
  globalThis.SRV = (name, priority, weight, port, target) => ["SRV", name, priority, weight, port, target];
  globalThis.CAA = (name, flag, tag, value) => ["CAA", name, flag, tag, value];
  globalThis.PTR = (name, target) => ["PTR", name, target];
  globalThis.IGNORE = (name) => ["IGNORE", name];
  globalThis.D = (zone, registrar, provider, records) => {
    zones[String(zone).toLowerCase()] = records;
  };
  globalThis.glob = (startPath, recursive, extension) => {
    const root = path.resolve(startPath);
    const out = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (extension && extension !== "*" && path.extname(entry.name) !== extension) continue;
      out.push(path.join(root, entry.name));
    }
    return out.sort();
  };

  const cwd = process.cwd();
  const target = path.join(dir, "dnsconfig.js");
  try {
    process.chdir(dir);
    delete require.cache[require.resolve(target)];
    require(target);
  } catch (error) {
    errors.push(error.message);
  } finally {
    process.chdir(cwd);
    for (const name of names) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
    delete require.cache[require.resolve(target)];
  }

  return { zones, error: errors.length > 0 ? errors[0] : null };
}

test("the record name comes from the filename", () => {
  const dir = registry({
    "jane.is-a.ceo.json": {
      owner: { username: "jane", id: 1 },
      records: { CNAME: "jane.github.io" },
    },
  });
  const { zones, error } = load(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(error, null, error);
  assert.ok(zones["is-a.ceo"], "the zone was declared");
  const cname = zones["is-a.ceo"].find((record) => record[0] === "CNAME");
  assert.equal(cname[1], "jane");
  assert.equal(cname[2], "jane.github.io.");
});

test("no records key publishes GitHub Pages with the proxy off", () => {
  const dir = registry({ "bare.is-a.ceo.json": { owner: { username: "bare", id: 2 } } });
  const { zones } = load(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  const records = zones["is-a.ceo"];
  assert.equal(records.filter((r) => r[0] === "A").length, 4);
  assert.equal(records.filter((r) => r[0] === "AAAA").length, 4);
  for (const record of records) assert.equal(record[3].cloudflare_proxy, "off");
});

test("proxied turns the Cloudflare proxy on for address records only", () => {
  const dir = registry({
    "web.is-a.ceo.json": {
      owner: { username: "web", id: 3 },
      proxied: true,
      records: { A: ["8.8.8.8"], TXT: ["v=spf1 -all"] },
    },
  });
  const { zones } = load(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  const a = zones["is-a.ceo"].find((record) => record[0] === "A");
  const txt = zones["is-a.ceo"].find((record) => record[0] === "TXT");
  assert.equal(a[3].cloudflare_proxy, "on");
  assert.equal(txt.length, 3, "TXT carries no proxy argument");
});

test("a target gets a trailing dot and an existing one is kept", () => {
  const dir = registry({
    "one.is-a.ceo.json": { owner: { username: "one", id: 4 }, records: { CNAME: "a.example.com" } },
    "two.is-a.ceo.json": { owner: { username: "two", id: 5 }, records: { CNAME: "b.example.com." } },
  });
  const { zones } = load(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  const targets = zones["is-a.ceo"].filter((record) => record[0] === "CNAME").map((record) => record[2]).sort();
  assert.deepEqual(targets, ["a.example.com.", "b.example.com."]);
});

test("every record type reaches the zone", () => {
  const dir = registry({
    "all.is-a.ceo.json": {
      owner: { username: "all", id: 6 },
      records: {
        A: ["8.8.8.8"],
        AAAA: ["2606:4700::1"],
        MX: [{ priority: 10, target: "mx.example.com" }],
        NS: ["ns1.example.net"],
        SRV: [{ priority: 0, weight: 5, port: 25565, target: "mc.example.com" }],
        CAA: [{ flag: 0, tag: "issue", value: "letsencrypt.org" }],
        PTR: ["host.example.com"],
      },
    },
  });
  const { zones } = load(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  const kinds = new Set(zones["is-a.ceo"].map((record) => record[0]));
  for (const kind of ["A", "AAAA", "MX", "NS", "SRV", "CAA", "PTR"]) assert.ok(kinds.has(kind), `${kind} missing`);
});

test("a file that names no managed zone is skipped, not declared", () => {
  const dir = registry({ "orphan.json": { owner: { username: "orphan", id: 7 } } });
  const { zones } = load(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(Object.keys(zones), []);
});

test("an empty zone list refuses to run", () => {
  const dir = registry({ "jane.is-a.ceo.json": {} }, []);
  const { error } = load(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(error, /lists no zones, refusing to push/);
});

test("the real dnsconfig.js declares the real registry", () => {
  const result = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  const files = fs.readdirSync(path.join(REPO, "domains")).filter((file) => file.endsWith(".json"));
  assert.ok(files.length > 0, "the registry has entries");
});

test("parseClaimFile reads the name out of the filename", () => {
  const zones = ["is-a.ceo"];
  assert.deepEqual(parseClaimFile("jane.is-a.ceo.json", zones), { subdomain: "jane", zone: "is-a.ceo" });
  assert.deepEqual(parseClaimFile("@.is-a.ceo.json", zones), { subdomain: "@", zone: "is-a.ceo" });
  assert.deepEqual(parseClaimFile("_vercel.jane.is-a.ceo.json", zones), { subdomain: "_vercel.jane", zone: "is-a.ceo" });
  assert.equal(parseClaimFile("is-a.ceo.json", zones), null);
  assert.equal(parseClaimFile("jane.example.net.json", zones), null);
  assert.equal(parseClaimFile("notes.txt", zones), null);
});

test("a multi-zone filename resolves to the zone it names", () => {
  const zones = ["is-a.ceo", "example.net"];
  assert.deepEqual(parseClaimFile("jane.example.net.json", zones), { subdomain: "jane", zone: "example.net" });
  assert.deepEqual(parseClaimFile("jane.is-a.ceo.json", zones), { subdomain: "jane", zone: "is-a.ceo" });
});

test("zone-wide and auxiliary names are told apart", () => {
  assert.equal(isZoneWide("@"), true);
  assert.equal(isZoneWide("*"), true);
  assert.equal(isZoneWide("_dmarc"), true);
  assert.equal(isZoneWide("_dmarc.jane"), false);
  assert.equal(isZoneWide("jane"), false);

  assert.equal(isAuxiliary("_vercel.jane"), true);
  assert.equal(isAuxiliary("_acme-challenge.jane"), true);
  assert.equal(isAuxiliary("docs.jane"), false);
  assert.equal(isAuxiliary("_dmarc"), false);
});

test("reservedWord sees through leetspeak and separators", () => {
  const policy = { reserved: new Set(["me", "status", "admin"]) };
  assert.equal(reservedWord("me", policy), "me");
  assert.equal(reservedWord("M3", policy), "me");
  assert.equal(reservedWord("meee", policy), "me");
  assert.equal(reservedWord("m-e", policy), "me");
  assert.equal(reservedWord("5tatus", policy), "status");
  assert.equal(reservedWord("jane", policy), null);
});

test("fold leaves a plain word alone", () => {
  assert.equal(fold("jane"), "jane");
  assert.equal(fold("jisoa"), "jisoa");
});

test("a reserved name with no entry file is ignored, never purged", () => {
  const dir = registry(
    {
      "caliph.is-a.ceo.json": { owner: { username: "caliph", id: 1 }, records: { CNAME: "server.caliph.dev" } },
    },
    ["is-a.ceo"],
    ["www", "docs", "mail"],
  );
  const { zones } = load(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  const ignored = zones["is-a.ceo"].filter((record) => record[0] === "IGNORE").map((record) => record[1]).sort();
  assert.deepEqual(ignored, ["docs", "mail", "www"]);
});

test("a reserved name that has an entry file is pushed, not ignored", () => {
  const dir = registry(
    { "docs.is-a.ceo.json": { owner: { username: "hisokalabs", id: 2 }, records: { CNAME: "hisokalabs.github.io" } } },
    ["is-a.ceo"],
    ["www", "docs"],
  );
  const { zones } = load(dir);
  fs.rmSync(dir, { recursive: true, force: true });

  const ignored = zones["is-a.ceo"].filter((record) => record[0] === "IGNORE").map((record) => record[1]);
  assert.deepEqual(ignored, ["www"], "only the unclaimed reserved name is ignored");
  assert.ok(zones["is-a.ceo"].some((record) => record[0] === "CNAME" && record[1] === "docs"));
});
