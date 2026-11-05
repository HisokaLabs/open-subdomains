"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO, "scripts");

const META = {
  _meta: {
    provider: "cloudflare",
    maxLength: 63,
    zones: ["is-a.ceo"],
    maintainers: ["hisokalabs", "dikaardnt", "rmdni-id"],
    reserved: ["api", "admin", "mail", "status", "dev", "is-a"],
    blocked: ["abuse", "security", "paypal", "github", "gmail"],
  },
};

const APEX = {
  domain: "is-a.ceo",
  subdomain: "@",
  owner: "HisokaLabs",
  records: { A: ["185.199.108.153"] },
};

function labelled(label, extra) {
  const host = label.replace(/\*/g, "wildcard");
  return {
    domain: "is-a.ceo",
    subdomain: label,
    owner: `owner-${host}`,
    records: { CNAME: [`${host}.example.com`] },
    ...extra,
  };
}

function makeRegistry(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const name of fs.readdirSync(SCRIPTS)) {
    fs.copyFileSync(path.join(SCRIPTS, name), path.join(dir, "scripts", name));
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  const domains = path.join(dir, "domains");
  fs.mkdirSync(domains);
  fs.writeFileSync(path.join(domains, "_meta.json"), JSON.stringify(META, null, 2));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(domains, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

function run(dir, script, env) {
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", script)], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function accepts(files) {
  return run(makeRegistry(files), "validate.js");
}

function rejects(files, pattern) {
  const { code, out } = accepts(files);
  assert.equal(code, 1, `expected a rejection, got exit 0:\n${out}`);
  if (pattern) assert.match(out, pattern);
  return out;
}

test("a plain CNAME claim passes", () => {
  assert.equal(accepts({ "@.is-a.ceo.json": APEX, "mc.is-a.ceo.json": labelled("mc") }).code, 0);
});

test("an A record claim passes", () => {
  const entry = labelled("web", { records: { A: ["203.0.113.10", "198.51.100.7"] } });
  accepts({ "web.is-a.ceo.json": entry });
  assert.equal(accepts({ "web.is-a.ceo.json": { ...entry, records: { A: ["8.8.8.8"] } } }).code, 0);
});

test("record-only shapes are accepted", () => {
  const shapes = {
    "txt.is-a.ceo.json": labelled("txt", { records: { TXT: ["v=spf1 -all"] } }),
    "mx.is-a.ceo.json": labelled("mx", { records: { MX: [{ priority: 10, target: "mx.example.com" }] } }),
    "ns.is-a.ceo.json": labelled("ns", { records: { NS: ["ns1.example.net", "ns2.example.net"] } }),
    "srv.is-a.ceo.json": labelled("srv", {
      records: { SRV: [{ priority: 0, weight: 5, port: 25565, target: "mc.example.com" }] },
    }),
    "ptr.is-a.ceo.json": labelled("ptr", { records: { PTR: ["host.example.com"] } }),
  };
  for (const [file, entry] of Object.entries(shapes)) {
    const { code, out } = accepts({ [file]: entry });
    assert.equal(code, 0, `${file} should pass:\n${out}`);
  }
});

test("an entry with no records gets the Pages default", () => {
  const entry = { domain: "is-a.ceo", subdomain: "bare", owner: "bare-owner" };
  assert.equal(accepts({ "bare.is-a.ceo.json": entry }).code, 0);
});

test("private and reserved IPv4 addresses are rejected", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "169.254.169.254", "172.16.0.1", "0.0.0.0", "224.0.0.1"]) {
    rejects({ "web.is-a.ceo.json": labelled("web", { records: { A: [ip] } }) }, /not a public IPv4/);
  }
});

test("IPv4 with a leading zero is rejected", () => {
  rejects({ "web.is-a.ceo.json": labelled("web", { records: { A: ["01.2.3.4"] } }) }, /not a public IPv4/);
});

test("an IPv4-mapped IPv6 address is judged as IPv4", () => {
  rejects({ "web.is-a.ceo.json": labelled("web", { records: { AAAA: ["::ffff:a9fe:a9fe"] } }) }, /not a public IPv6/);
  rejects({ "web.is-a.ceo.json": labelled("web", { records: { AAAA: ["::ffff:127.0.0.1"] } }) }, /not a public IPv6/);
  assert.equal(accepts({ "web.is-a.ceo.json": labelled("web", { records: { AAAA: ["::ffff:8.8.8.8"] } }) }).code, 0);
});

test("link-local, unique-local and documentation IPv6 is rejected", () => {
  for (const ip of ["::1", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1"]) {
    rejects({ "web.is-a.ceo.json": labelled("web", { records: { AAAA: [ip] } }) }, /not a public IPv6/);
  }
});

test("a CNAME cannot coexist with address records", () => {
  rejects(
    { "web.is-a.ceo.json": labelled("web", { records: { CNAME: ["web.example.com"], A: ["8.8.8.8"] } }) },
    /CNAME cannot coexist with A/,
  );
});

test("a CNAME may coexist with TXT and CAA", () => {
  const entry = labelled("web", {
    records: { CNAME: ["web.example.com"], TXT: ["hello"], CAA: [{ flag: 0, tag: "issue", value: "letsencrypt.org" }] },
  });
  assert.equal(accepts({ "web.is-a.ceo.json": entry }).code, 0);
});

test("duplicate record values are rejected", () => {
  rejects(
    { "web.is-a.ceo.json": labelled("web", { records: { A: ["8.8.8.8", "8.8.8.8"] } }) },
    /duplicate value/,
  );
});

test("the apex cannot use CNAME or NS", () => {
  rejects({ "@.is-a.ceo.json": { ...APEX, records: { CNAME: ["x.example.com"] } } }, /apex cannot use CNAME/);
  rejects({ "@.is-a.ceo.json": { ...APEX, records: { NS: ["ns1.example.com"] } } }, /apex cannot delegate/);
});

test("local-only record targets are rejected", () => {
  for (const target of ["localhost", "box.local", "nas.home.arpa", "thing.internal", "example"]) {
    rejects({ "web.is-a.ceo.json": labelled("web", { records: { CNAME: [target] } }) }, /not a valid public CNAME target/);
  }
});

test("unknown keys are rejected", () => {
  rejects({ "web.is-a.ceo.json": labelled("web", { evil: true }) }, /unknown key "evil"/);
});

test("the file must be named after subdomain and zone", () => {
  rejects({ "wrong.json": labelled("web") }, /file must be named "web\.is-a\.ceo\.json"/);
});

test("the zone must be managed", () => {
  rejects({ "web.example.org.json": { ...labelled("web"), domain: "example.org" } }, /not a managed zone/);
});

test("reserved and blocked labels are rejected", () => {
  rejects({ "api.is-a.ceo.json": labelled("api") }, /reserved by the registry/);
  rejects({ "paypal.is-a.ceo.json": labelled("paypal") }, /blocked by the registry/);
});

test("one subdomain per owner per zone", () => {
  rejects(
    {
      "one.is-a.ceo.json": labelled("one", { owner: "same" }),
      "two.is-a.ceo.json": labelled("two", { owner: "same" }),
    },
    /already has one\.is-a\.ceo/,
  );
});

test("a trailing space in owner does not dodge the quota", () => {
  rejects(
    {
      "one.is-a.ceo.json": labelled("one", { owner: "same" }),
      "two.is-a.ceo.json": labelled("two", { owner: "same " }),
    },
    /already has/,
  );
});

const skipOnWindows = process.platform === "win32"
  ? "Windows forbids * in filenames, so this case cannot be built here"
  : false;

test("a bare wildcard is maintainer-only", { skip: skipOnWindows }, () => {
  rejects({ "*.is-a.ceo.json": labelled("*", { owner: "random-person" }) }, /wildcard "\*" is maintainer-only/);
  assert.equal(accepts({ "*.is-a.ceo.json": labelled("*", { owner: "rmdni-id" }) }).code, 0);
});

test("a wildcard needs its base claimed by the same owner", { skip: skipOnWindows }, () => {
  rejects({ "*.base.is-a.ceo.json": labelled("*.base", { owner: "someone" }) }, /claimed by the same owner/);
  const owned = {
    "base.is-a.ceo.json": labelled("base", { owner: "someone" }),
    "*.base.is-a.ceo.json": labelled("*.base", { owner: "someone" }),
  };
  assert.equal(accepts(owned).code, 0);
});

test("an underscore record needs its base claimed by the same owner", () => {
  rejects(
    { "_acme-challenge.base.is-a.ceo.json": labelled("_acme-challenge.base", { records: { TXT: ["token"] } }) },
    /claimed by the same owner/,
  );
  const owned = {
    "base.is-a.ceo.json": labelled("base", { owner: "someone" }),
    "_acme-challenge.base.is-a.ceo.json": labelled("_acme-challenge.base", {
      owner: "someone",
      records: { TXT: ["token"] },
    }),
  };
  assert.equal(accepts(owned).code, 0);
});

test("an underscore record cannot hijack another owner's base", () => {
  rejects(
    {
      "base.is-a.ceo.json": labelled("base", { owner: "victim" }),
      "_dmarc.base.is-a.ceo.json": labelled("_dmarc.base", { owner: "attacker", records: { TXT: ["v=DMARC1;p=none"] } }),
    },
    /claimed by the same owner/,
  );
});

test("a service SRV record needs no base claim", () => {
  const entry = labelled("_minecraft._tcp.mc", {
    records: { SRV: [{ priority: 0, weight: 5, port: 25565, target: "mc.example.com" }] },
  });
  assert.equal(accepts({ "_minecraft._tcp.mc.is-a.ceo.json": entry }).code, 0);
});

test("invalid JSON fails with the filename", () => {
  rejects({ "web.is-a.ceo.json": "{ nope" }, /web\.is-a\.ceo\.json: invalid JSON/);
});

test("verify-owners rejects a claim by someone other than the PR author", () => {
  const dir = makeRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "not-the-author" }) });
  const { code, out } = run(dir, "verify-owners.js", { PR_AUTHOR: "the-author" });
  assert.equal(code, 1);
  assert.match(out, /not-the-author/);
});

test("verify-owners accepts a claim by the PR author, case-insensitively", () => {
  const dir = makeRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "TheAuthor" }) });
  assert.equal(run(dir, "verify-owners.js", { PR_AUTHOR: "theauthor" }).code, 0);
});

test("the real registry in this repository passes", () => {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, "validate.js")], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /verified/);
});
