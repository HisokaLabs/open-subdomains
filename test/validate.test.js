"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO, "scripts");

const ZONES = ["is-a.ceo"];

const RESERVED = ["admin", "api", "mail", "status", "dev", "me", "my", "i", "blog", "docs", "www", "the"];

const BLOCKED = ["paypal", "github", "gmail"];

const TRUSTED = [
  { username: "dikaardnt", id: 88322331, admin: true },
  { username: "hisokalabs", id: 103969998, admin: false },
];

const FULL = { username: "jisoa", id: 9001 };

function claimFile(label) {
  return `${label}.is-a.ceo.json`;
}

function entry(extra = {}) {
  return { owner: { ...FULL }, records: { CNAME: "target.example.com" }, ...extra };
}

function owner(username = FULL.username, extra = {}) {
  return { username, id: FULL.id, ...extra };
}

function makeRegistry(files, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const name of fs.readdirSync(SCRIPTS)) {
    fs.copyFileSync(path.join(SCRIPTS, name), path.join(dir, "scripts", name));
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true }));

  const policy = path.join(dir, "registry");
  fs.mkdirSync(policy);
  fs.writeFileSync(path.join(policy, "zones.json"), JSON.stringify(options.zones || ZONES));
  fs.writeFileSync(path.join(policy, "reserved.json"), JSON.stringify(options.reserved || RESERVED));
  fs.writeFileSync(path.join(policy, "blocked.json"), JSON.stringify(options.blocked || BLOCKED));
  fs.writeFileSync(path.join(policy, "trusted.json"), JSON.stringify(options.trusted || TRUSTED));
  fs.writeFileSync(path.join(policy, "schema.json"), "{}");
  fs.writeFileSync(path.join(policy, "example.json"), "{}");

  fs.mkdirSync(path.join(dir, "domains"));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, "domains", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return dir;
}

function git(dir, args) {
  const result = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function gitAvailable() {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

function run(dir, env = {}, script = "validate.js", args = []) {
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", script), ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, stdout: result.stdout };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function passes(files, env, options) {
  const dir = makeRegistry(files, options);
  const result = run(dir, env);
  cleanup(dir);
  assert.equal(result.code, 0, `expected a pass, got exit ${result.code}:\n${result.out}`);
  return result;
}

function fails(files, pattern, env, options) {
  const dir = makeRegistry(files, options);
  const result = run(dir, env);
  cleanup(dir);
  assert.equal(result.code, 1, `expected a rejection, got exit 0:\n${result.out}`);
  if (pattern) assert.match(result.out, pattern);
  return result;
}

test("a plain CNAME claim passes", () => {
  passes({ [claimFile("jane")]: entry() });
});

test("an entry with no records gets the Pages default", () => {
  passes({ [claimFile("bare")]: { owner: owner() } });
});

test("the filename is the only place the name is written", () => {
  fails({ [claimFile("jane")]: entry({ subdomain: "jane" }) }, /unknown key "subdomain"/);
  fails({ [claimFile("jane")]: entry({ domain: "is-a.ceo" }) }, /unknown key "domain"/);
});

test("an entry whose filename names no managed zone is refused", () => {
  fails({ "jane.example.net.json": entry() }, /must be <subdomain>\.<zone>\.json/);
  fails({ "jane.json": entry() }, /must be <subdomain>\.<zone>\.json/);
});

test("record-only shapes are accepted", () => {
  const shapes = {
    verified: { TXT: ["v=spf1 -all"] },
    mailbox: { MX: [{ priority: 10, target: "mx.example.com" }] },
    delegate: { NS: ["ns1.example.net", "ns2.example.net"] },
    minecraft: { SRV: [{ priority: 0, weight: 5, port: 25565, target: "mc.example.com" }] },
    reverse: { PTR: ["host.example.com"] },
  };
  for (const [label, records] of Object.entries(shapes)) {
    passes({ [claimFile(label)]: { owner: owner(), records } });
  }
});

test("private, reserved and documentation addresses are rejected", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "169.254.169.254", "172.16.0.1", "0.0.0.0", "203.0.113.10"]) {
    fails({ [claimFile("web")]: { owner: owner(), records: { A: [ip] } } }, /not a public IPv4/);
  }
});

test("IPv4 with a leading zero is rejected", () => {
  fails({ [claimFile("web")]: { owner: owner(), records: { A: ["01.2.3.4"] } } }, /not a public IPv4/);
});

test("an IPv4-mapped IPv6 address is judged as IPv4", () => {
  fails({ [claimFile("web")]: { owner: owner(), records: { AAAA: ["::ffff:127.0.0.1"] } } }, /not a public IPv6/);
  passes({ [claimFile("web")]: { owner: owner(), records: { AAAA: ["::ffff:8.8.8.8"] } } });
});

test("link-local, unique-local and documentation IPv6 is rejected", () => {
  for (const ip of ["::1", "fe80::1", "fc00::1", "ff02::1", "2001:db8::1"]) {
    fails({ [claimFile("web")]: { owner: owner(), records: { AAAA: [ip] } } }, /not a public IPv6/);
  }
});

test("a CNAME cannot share its name with an address record", () => {
  fails(
    { [claimFile("web")]: { owner: owner(), records: { CNAME: "x.example.com", A: ["8.8.8.8"] } } },
    /CNAME cannot share its name with A/,
  );
});

test("a CNAME may share its name with TXT and CAA", () => {
  passes({
    [claimFile("web")]: {
      owner: owner(),
      proxied: true,
      records: { CNAME: "x.example.com", TXT: ["v=spf1 -all"], CAA: [{ flag: 0, tag: "issue", value: "letsencrypt.org" }] },
    },
  });
});

test("the apex cannot use CNAME or NS", () => {
  const trusted = owner("hisokalabs", { id: 103969998 });
  fails({ "@.is-a.ceo.json": { owner: trusted, records: { CNAME: "x.example.com" } } }, /the apex cannot carry a CNAME/);
  fails({ "@.is-a.ceo.json": { owner: trusted, records: { NS: ["ns1.example.net"] } } }, /the apex cannot delegate/);
});

test("local-only record targets are rejected", () => {
  for (const target of ["localhost", "printer.local", "host.internal", "x.ts.net"]) {
    fails({ [claimFile("web")]: { owner: owner(), records: { CNAME: target } } }, /not a valid public CNAME/);
  }
});

test("a self-referencing CNAME is rejected", () => {
  fails({ [claimFile("jane")]: { owner: owner(), records: { CNAME: "jane.is-a.ceo" } } }, /cannot point at the name it sits on/);
  fails({ [claimFile("jane")]: { owner: owner(), records: { CNAME: "is-a.ceo" } } }, /cannot point at the name it sits on/);
});

test("a CNAME takes one target and accepts a string or an array", () => {
  passes({ [claimFile("one")]: { owner: owner(), records: { CNAME: "a.example.com" } } });
  passes({ [claimFile("two")]: { owner: owner(), records: { CNAME: ["a.example.com"] } } });
  fails(
    { [claimFile("three")]: { owner: owner(), records: { CNAME: ["a.example.com", "b.example.com"] } } },
    /takes one target/,
  );
});

test("duplicate record values are rejected", () => {
  fails({ [claimFile("web")]: { owner: owner(), records: { A: ["8.8.8.8", "8.8.8.8"] } } }, /repeats a value/);
});

test("unknown keys are rejected", () => {
  fails({ [claimFile("jane")]: { owner: owner(), descrition: "typo" } }, /unknown key "descrition"/);
});

test("a top-level email is refused, it belongs inside owner", () => {
  fails({ [claimFile("jane")]: { owner: owner(), email: "jane@example.com" } }, /unknown key "email"/);
});

test("owner must be an object", () => {
  fails({ [claimFile("jane")]: { owner: "jane" } }, /"owner" must be an object/);
});

test("owner takes any one of username, id or email", () => {
  passes({ [claimFile("jane")]: { owner: { username: "jane" } } });
  passes({ [claimFile("jane")]: { owner: { id: 12345 } } });
  passes({ [claimFile("jane")]: { owner: { email: "jane@example.com" } } });
  passes({ [claimFile("jane")]: { owner: { username: "jane", id: 12345 } } });
});

test("an empty owner object is refused", () => {
  fails({ [claimFile("jane")]: { owner: {} } }, /"owner" is empty/);
  fails({ [claimFile("jane")]: { owner: { username: "   " } } }, /"owner" is empty/);
});

test("an entry identified only by email cannot be claimed by an ordinary author", () => {
  const files = { [claimFile("newone")]: { owner: { email: "jane@example.com" } } };
  const changed = { CHANGED_FILES: JSON.stringify([`domains/${claimFile("newone")}`]) };
  fails(files, /has only an email/, { ...changed, PR_AUTHOR: "jane" });
  passes(files, { ...changed, PR_AUTHOR: "dikaardnt", PR_AUTHOR_ID: "88322331" });
});

test("owner.id must be a positive whole number", () => {
  fails({ [claimFile("jane")]: { owner: { username: "jane", id: "12345" } } }, /owner\.id must be the numeric GitHub account id/);
  fails({ [claimFile("jane")]: { owner: { username: "jane", id: 0 } } }, /owner\.id must be the numeric GitHub account id/);
});

test("owner.username has to be a GitHub handle", () => {
  for (const name of ["-jane", "jane-", "ja ne", "jane@home"]) {
    fails({ [claimFile("jane")]: { owner: { username: name, id: 1 } } }, /owner\.username .* is not a GitHub handle/);
  }
});

test("an unknown owner key is refused", () => {
  fails({ [claimFile("jane")]: { owner: { username: "jane", id: 1, login: "jane" } } }, /unknown owner key "login"/);
});

test("the zone must be managed", () => {
  fails({ "jane.example.net.json": entry() }, /must be <subdomain>\.<zone>\.json/, {}, { zones: ["is-a.ceo"] });
});

test("blocked labels are refused whoever holds them", () => {
  fails({ [claimFile("paypal")]: entry() }, /"paypal" is blocked by the registry/);
  fails({ [claimFile("gmail")]: entry() }, /"gmail" is blocked by the registry/);
});

test("a blocked label stays blocked even for a trusted author", () => {
  const trusted = { owner: owner("hisokalabs", { id: 103969998 }) };
  fails({ [claimFile("paypal")]: trusted }, /"paypal" is blocked by the registry/);
});

test("reserved labels are refused", () => {
  fails({ [claimFile("status")]: entry() }, /"status" is reserved/);
});

test("a reserved label is claimable by a trusted author", () => {
  passes({ [claimFile("docs")]: { owner: owner("hisokalabs", { id: 103969998 }) } });
});

test("a dressed-up reserved word still hits the list", () => {
  const env = { PR_AUTHOR: "someone", PR_AUTHOR_ID: "4242" };
  for (const label of ["m3", "meee", "m-e", "5tatus"]) {
    fails({ [claimFile(label)]: { owner: owner("someone", { id: 4242 }) } }, /is reserved/, env);
  }
});

test("the fold leaves ordinary names alone", () => {
  for (const label of ["jane", "jisoa", "someone-else", "abc123"]) {
    passes({ [claimFile(label)]: entry() });
  }
});

test("a claim belongs to the account that opens the pull request", () => {
  const files = { [claimFile("newone")]: { owner: owner("jisoa", { id: 9001 }) } };
  const changed = { CHANGED_FILES: JSON.stringify([`domains/${claimFile("newone")}`]) };
  fails(files, /is not the account opening this pull request/, { ...changed, PR_AUTHOR: "jisoa", PR_AUTHOR_ID: "7777" });
  passes(files, { ...changed, PR_AUTHOR: "jisoa", PR_AUTHOR_ID: "9001" });
});

test("an id match beats a renamed username", () => {
  const files = { [claimFile("newone")]: { owner: owner("old-handle", { id: 9001 }) } };
  const changed = { CHANGED_FILES: JSON.stringify([`domains/${claimFile("newone")}`]) };
  passes(files, { ...changed, PR_AUTHOR: "new-handle", PR_AUTHOR_ID: "9001" });
});

test("a claim with only an email matches on the username", () => {
  const files = { [claimFile("newone")]: { owner: { username: "somebody", email: "s@example.com" } } };
  const changed = { CHANGED_FILES: JSON.stringify([`domains/${claimFile("newone")}`]) };
  passes(files, { ...changed, PR_AUTHOR: "Somebody" });
  fails(files, /is not the account opening/, { ...changed, PR_AUTHOR: "other" });
});

test("one owner may hold several names", () => {
  passes({ [claimFile("one")]: entry(), [claimFile("two")]: entry(), [claimFile("three")]: entry() });
});

// NTFS refuses "*" in a filename, so these two only run where CI does.
const skipOnWindows = process.platform === "win32" ? "a filename cannot contain * on Windows" : false;

test("a wildcard needs its base claimed by the same owner", { skip: skipOnWindows }, () => {
  const base = { owner: owner(), records: { A: ["8.8.8.8"] } };
  passes({ [claimFile("app")]: base, [claimFile("*.app")]: { owner: owner(), records: { A: ["8.8.8.8"] } } });
  fails(
    {
      [claimFile("app")]: base,
      [claimFile("*.app")]: { owner: owner("intruder", { id: 7 }), records: { A: ["9.9.9.9"] } },
    },
    /needs "app" in is-a\.ceo claimed by the same owner/,
  );
});

test("an underscore record needs its base claimed by the same owner", () => {
  const base = { owner: owner(), records: { A: ["8.8.8.8"] } };
  fails(
    { [claimFile("app")]: base, [claimFile("_acme-challenge.app")]: { owner: owner("intruder", { id: 7 }), records: { TXT: ["x"] } } },
    /claimed by the same owner first/,
  );
});

test("a service SRV record needs no base claim", () => {
  passes({
    [claimFile("_minecraft._tcp.mc")]: {
      owner: owner(),
      records: { SRV: [{ priority: 0, weight: 5, port: 25565, target: "mc.example.com" }] },
    },
  });
});

test("a zone-wide name is trusted-only", { skip: skipOnWindows }, () => {
  const trusted = owner("hisokalabs", { id: 103969998 });
  fails({ "@.is-a.ceo.json": { owner: owner(), records: { A: ["8.8.8.8"] } } }, /answers for every name in the zone/);
  fails({ [claimFile("*")]: { owner: owner(), records: { A: ["8.8.8.8"] } } }, /answers for every name in the zone/);
  fails({ [claimFile("_dmarc")]: { owner: owner(), records: { TXT: ["v=DMARC1; p=none"] } } }, /answers for every name in the zone/);
  passes({ "@.is-a.ceo.json": { owner: trusted, records: { A: ["8.8.8.8"] } } });
});

test("two owners cannot point at one host", () => {
  fails(
    {
      [claimFile("one")]: { owner: owner(), records: { CNAME: "shared.example.com" } },
      [claimFile("two")]: { owner: owner("intruder", { id: 7 }), records: { CNAME: "shared.example.com" } },
    },
    /also used by one\.is-a\.ceo under a different owner/,
  );
});

test("the same owner may reuse a target", () => {
  passes({
    [claimFile("one")]: { owner: owner(), records: { CNAME: "shared.example.com" } },
    [claimFile("two")]: { owner: owner(), records: { CNAME: "shared.example.com" } },
  });
});

test("a Vercel proof only counts on its own sidecar name", () => {
  const proof = "vc-domain-verify=jane.is-a.ceo,abc123";
  const base = { [claimFile("jane")]: entry() };

  fails({ [claimFile("_vercel.other")]: { owner: owner(), records: { TXT: [proof] } } }, /counts on "_vercel\.jane\.is-a\.ceo"/);
  fails({ [claimFile("jane")]: { owner: owner(), records: { TXT: [proof] } } }, /counts on "_vercel\.jane\.is-a\.ceo"/);
  passes({ ...base, [claimFile("_vercel.jane")]: { owner: owner(), records: { TXT: [proof] } } });
});

test("an uppercase filename is refused before it can shadow a lowercase one", () => {
  fails({ "Jane.is-a.ceo.json": entry() }, /the subdomain must be lowercase/);
});

test("invalid JSON names the file and the position", () => {
  fails({ [claimFile("jane")]: "{ not json" }, /jane\.is-a\.ceo\.json: invalid JSON/);
});

test("an entry that is an array is refused", () => {
  fails({ [claimFile("jane")]: "[]" }, /an entry is one JSON object/);
});

test("a symlinked entry is refused", { skip: process.platform === "win32" }, () => {
  const dir = makeRegistry({});
  fs.symlinkSync(path.join(dir, "package.json"), path.join(dir, "domains", claimFile("jane")));
  const result = run(dir);
  cleanup(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /entries are regular files/);
});

test("an entry without a .json extension is refused", () => {
  fails({ "jane.is-a.ceo": JSON.stringify(entry()) }, /every entry filename ends in \.json/);
});

test("a subdirectory inside domains/ is refused", () => {
  const dir = makeRegistry({ [claimFile("jane")]: entry() });
  fs.mkdirSync(path.join(dir, "domains", "extra"));
  const result = run(dir);
  cleanup(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /holds subdirectories/);
});

test("--json is one object with ok, verified, problems and warnings", () => {
  const dir = makeRegistry({ [claimFile("jane")]: entry() });
  const result = run(dir, {}, "validate.js", ["--json"]);
  cleanup(dir);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ["ok", "problems", "verified", "warnings"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verified, 1);
});

test("every problem in one run is reported together", () => {
  const result = fails(
    {
      [claimFile("paypal")]: entry(),
      [claimFile("mine")]: { owner: owner(), records: { A: ["10.0.0.1"] } },
    },
    undefined,
  );
  assert.match(result.out, /"paypal" is blocked/);
  assert.match(result.out, /not a public IPv4/);
});

test("a maintainer may change the trusted list, a member may not", () => {
  const base = { trusted: TRUSTED };
  const files = { [claimFile("jane")]: entry() };
  const dir = makeRegistry(files, base);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  const next = [...TRUSTED, { username: "newperson", id: 555 }];
  fs.writeFileSync(path.join(dir, "registry", "trusted.json"), JSON.stringify(next));

  const member = run(dir, { PR_AUTHOR: "hisokalabs", PR_AUTHOR_ID: "103969998" });
  assert.equal(member.code, 1, member.out);
  assert.match(member.out, /only an admin can change the trusted list/);

  const admin = run(dir, { PR_AUTHOR: "dikaardnt", PR_AUTHOR_ID: "88322331" });
  assert.equal(admin.code, 0, admin.out);

  cleanup(dir);
});

test("a stranger cannot grant themselves trust", () => {
  const dir = makeRegistry({ [claimFile("jane")]: entry() });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  fs.writeFileSync(
    path.join(dir, "registry", "trusted.json"),
    JSON.stringify([...TRUSTED, { username: "stranger", id: 999 }]),
  );

  const result = run(dir, { PR_AUTHOR: "stranger", PR_AUTHOR_ID: "999" });
  cleanup(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /only an admin can grant trust/);
});

test("a stranger cannot drop a blocked word", () => {
  const dir = makeRegistry({ [claimFile("jane")]: entry() });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  fs.writeFileSync(path.join(dir, "registry", "blocked.json"), JSON.stringify(["abuse"]));

  const result = run(dir, { PR_AUTHOR: "stranger", PR_AUTHOR_ID: "999" });
  cleanup(dir);
  assert.equal(result.code, 1);
  assert.match(result.out, /only trusted authors can loosen/);
});

test("a claim pull request that touches scripts is refused", () => {
  const files = { [claimFile("jane")]: entry() };
  const changed = { CHANGED_FILES: JSON.stringify([`domains/${claimFile("jane")}`, "scripts/validate.js"]) };
  fails(files, /only a trusted author can change this/, { ...changed, PR_AUTHOR: "jisoa", PR_AUTHOR_ID: "9001" });
});

test("a contributor may fix a typo in the documentation", () => {
  const files = { [claimFile("jane")]: entry() };
  const changed = { CHANGED_FILES: JSON.stringify([`domains/${claimFile("jane")}`, "README.md"]) };
  passes(files, { ...changed, PR_AUTHOR: "jisoa", PR_AUTHOR_ID: "9001" });
});

test("one pull request carrying a crowd of entries is refused", () => {
  const files = {};
  for (let i = 0; i < 6; i += 1) files[claimFile(`name${i}`)] = entry();
  const changed = { CHANGED_FILES: JSON.stringify(Object.keys(files).map((f) => `domains/${f}`)) };
  fails(files, /a claim is one entry/, { ...changed, PR_AUTHOR: "jisoa", PR_AUTHOR_ID: "9001" });
});

test("the report carries its marker and explains a failure", () => {
  const dir = makeRegistry({ [claimFile("paypal")]: entry() });
  const result = run(dir, {}, "report.js");
  cleanup(dir);
  assert.match(result.stdout, /<!-- registry-validator -->/);
  assert.match(result.stdout, /needs a change/);
  assert.match(result.stdout, /blocked by the registry/);
  assert.match(result.stdout, /is on registry\/blocked\.json/);
});

test("the report stays quiet about a clean registry", () => {
  const dir = makeRegistry({ [claimFile("jane")]: entry() });
  const result = run(dir, {}, "report.js");
  cleanup(dir);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Registry check passed/);
});

test("the real registry in this repository passes", () => {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, "validate.js")], {
    cwd: REPO,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("the fold maps leetspeak onto the plain word", () => {
  const { fold } = require(path.join(SCRIPTS, "registry.js"));
  assert.equal(fold("M3"), "me");
  assert.equal(fold("meee"), "me");
  assert.equal(fold("m-e"), "me");
  assert.equal(fold("m_e"), "me");
  assert.equal(fold("$tatus"), "status");
  assert.equal(fold("jane"), "jane");
});

test("the claim-one-entry rule stays quiet outside a pull request", () => {
  // On the base branch the diff against its own upstream is every unpushed
  // commit, not a change set, so the scope rules must step aside.
  const dir = makeRegistry({ [claimFile("jane")]: entry() });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "base"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(
      path.join(dir, "domains", claimFile(`name${i}`)),
      `${JSON.stringify({ owner: { ...FULL }, records: { CNAME: `${i}.example.com` } }, null, 2)}\n`,
    );
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "six entries on main"]);

  const onMain = run(dir, { PR_AUTHOR: "jisoa", PR_AUTHOR_ID: "9001" });
  assert.equal(onMain.code, 0, `a direct commit on main is not a claim PR:\n${onMain.out}`);

  cleanup(dir);
});
