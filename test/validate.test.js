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
    maintainers: ["hisokalabs", "dikaardnt", "daningl"],
    reserved: ["api", "admin", "mail", "status", "dev", "is-a"],
    blocked: ["abuse", "security", "paypal", "github", "gmail"],
    namePolicy: {
      reservedClasses: ["pronoun"],
      advisoryClasses: ["generic-noun"],
    },
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

function gitAvailable() {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

function gitRun(dir, args) {
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
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:
${result.stderr}`);
  return result.stdout;
}

function makeGitRegistry(files, mutate) {
  const dir = makeRegistry({});
  gitRun(dir, ["init", "-q", "-b", "main"]);
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, "domains", file), JSON.stringify(content, null, 2));
  }
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-q", "-m", "base"]);
  gitRun(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  mutate(dir);
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
  rejects(
    { "ns.is-a.ceo.json": labelled("ns", { records: { NS: ["ns1.example.com", "ns1.example.com."] } }) },
    /duplicate value/,
  );
  rejects(
    { "ns2.is-a.ceo.json": labelled("ns2", { records: { NS: ["ns1.example.com", "NS1.EXAMPLE.COM"] } }) },
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
  rejects({ "*.is-a.ceo.json": labelled("*", { owner: "random-person" }) }, /is a zone-wide name, so maintainers hold it/);
  assert.equal(accepts({ "*.is-a.ceo.json": labelled("*", { owner: "daningl" }) }).code, 0);
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

test("a zone-root underscore name is maintainer-only", () => {
  rejects(
    { "_acme-challenge.is-a.ceo.json": labelled("_acme-challenge", { records: { TXT: ["token"] } }) },
    /is a zone-wide name, so maintainers hold it/,
  );
  rejects(
    { "_vercel.is-a.ceo.json": labelled("_vercel", { records: { TXT: ["vc-domain-verify=is-a.ceo,x"] } }) },
    /is a zone-wide name, so maintainers hold it/,
  );
  const held = labelled("_dmarc", { owner: "daningl", records: { TXT: ["v=DMARC1; p=none"] } });
  assert.equal(accepts({ "_dmarc.is-a.ceo.json": held }).code, 0);
});

test("a zone-wide record does not consume its holder's quota", () => {
  const files = {
    "@.is-a.ceo.json": APEX,
    "www.is-a.ceo.json": labelled("www", { owner: "HisokaLabs", records: { CNAME: ["hisokalabs.github.io"] } }),
    "_vercel.is-a.ceo.json": labelled("_vercel", {
      owner: "HisokaLabs",
      records: { TXT: ["some-service-verification=anyone"] },
    }),
  };
  assert.equal(accepts(files).code, 0);
});

test("a dotted underscore record is not zone-wide", () => {
  const owned = {
    "holder.is-a.ceo.json": labelled("holder", { owner: "holder" }),
    "_vercel.holder.is-a.ceo.json": labelled("_vercel.holder", {
      owner: "holder",
      records: { TXT: ["vc-domain-verify=holder.is-a.ceo,x"] },
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

test("a Vercel proof published under someone else's name is rejected", () => {
  rejects(
    {
      "attacker.is-a.ceo.json": labelled("attacker", { owner: "attacker" }),
      "_vercel.attacker.is-a.ceo.json": labelled("_vercel.attacker", {
        owner: "attacker",
        records: { TXT: ["vc-domain-verify=victim.is-a.ceo,deadbeef"] },
      }),
    },
    /only counts on "_vercel\.victim\.is-a\.ceo"/,
  );
});

test("a Vercel proof under its own name passes", () => {
  const owned = {
    "holder.is-a.ceo.json": labelled("holder", { owner: "holder" }),
    "_vercel.holder.is-a.ceo.json": labelled("_vercel.holder", {
      owner: "holder",
      records: { TXT: ["vc-domain-verify=holder.is-a.ceo,deadbeef"] },
    }),
  };
  assert.equal(accepts(owned).code, 0);
});

test("a Vercel proof on the claim's own name is rejected", () => {
  const inline = labelled("holder", {
    owner: "holder",
    records: { CNAME: ["holder.vercel.app"], TXT: ["vc-domain-verify=holder.is-a.ceo,deadbeef"] },
  });
  rejects({ "holder.is-a.ceo.json": inline }, /only counts on "_vercel\.holder\.is-a\.ceo"/);
});

test("a Vercel proof on the zone root is rejected", () => {
  const root = labelled("_vercel", {
    owner: "holder",
    records: { TXT: ["vc-domain-verify=holder.is-a.ceo,deadbeef"] },
  });
  rejects({ "holder.is-a.ceo.json": labelled("holder", { owner: "holder" }), "_vercel.is-a.ceo.json": root }, /zone-wide name, so maintainers hold it/);
});

test("a Vercel sidecar cannot point at another person's name", () => {
  const stolen = labelled("_vercel.holder", {
    owner: "attacker",
    records: { TXT: ["vc-domain-verify=holder.is-a.ceo,deadbeef"] },
  });
  rejects({ "holder.is-a.ceo.json": labelled("holder", { owner: "holder" }), "_vercel.holder.is-a.ceo.json": stolen }, /claimed by the same owner/);
});

test("vercel-proof writes the sidecar from a bare token", () => {
  const dir = makeRegistry({ "holder.is-a.ceo.json": labelled("holder", { owner: "holder" }) });
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "vercel-proof.js"), "--name", "holder", "--token", "deadbeef"], {
    encoding: "utf8",
    cwd: dir,
  });
  const written = path.join(dir, "domains", "_vercel.holder.is-a.ceo.json");
  const body = JSON.parse(fs.readFileSync(written, "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(body.subdomain, "_vercel.holder");
  assert.equal(body.owner, "holder");
  assert.deepEqual(body.records.TXT, ["vc-domain-verify=holder.is-a.ceo,deadbeef"]);
});

test("vercel-proof refuses a proof minted for another name", () => {
  const dir = makeRegistry({ "holder.is-a.ceo.json": labelled("holder", { owner: "holder" }) });
  const result = spawnSync(
    process.execPath,
    [path.join(dir, "scripts", "vercel-proof.js"), "--name", "holder", "--proof", "vc-domain-verify=other.is-a.ceo,deadbeef"],
    { encoding: "utf8", cwd: dir },
  );
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verifies "other\.is-a\.ceo"/);
});

test("vercel-proof keeps every proof already in the sidecar", () => {
  const dir = makeRegistry({
    "holder.is-a.ceo.json": labelled("holder", { owner: "holder" }),
    "_vercel.holder.is-a.ceo.json": labelled("_vercel.holder", {
      owner: "holder",
      records: { TXT: ["vc-domain-verify=holder.is-a.ceo,aaa111"] },
    }),
  });
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "vercel-proof.js"), "--name", "holder", "--token", "bbb222"], {
    encoding: "utf8",
    cwd: dir,
  });
  const body = JSON.parse(fs.readFileSync(path.join(dir, "domains", "_vercel.holder.is-a.ceo.json"), "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(body.records.TXT, ["vc-domain-verify=holder.is-a.ceo,aaa111", "vc-domain-verify=holder.is-a.ceo,bbb222"]);
});

test("vercel-proof --remove drops only the sidecar", () => {
  const dir = makeRegistry({
    "holder.is-a.ceo.json": labelled("holder", { owner: "holder" }),
    "_vercel.holder.is-a.ceo.json": labelled("_vercel.holder", {
      owner: "holder",
      records: { TXT: ["vc-domain-verify=holder.is-a.ceo,deadbeef"] },
    }),
  });
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "vercel-proof.js"), "--name", "holder", "--remove"], {
    encoding: "utf8",
    cwd: dir,
  });
  const sidecarGone = !fs.existsSync(path.join(dir, "domains", "_vercel.holder.is-a.ceo.json"));
  const claimKept = fs.existsSync(path.join(dir, "domains", "holder.is-a.ceo.json"));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(sidecarGone, true);
  assert.equal(claimKept, true);
});

test("vercel-proof refuses a name nobody claimed", () => {
  const dir = makeRegistry({ "holder.is-a.ceo.json": labelled("holder", { owner: "holder" }) });
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "vercel-proof.js"), "--name", "ghost", "--token", "deadbeef"], {
    encoding: "utf8",
    cwd: dir,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /claim the name first/);
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
  const dir1 = makeRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "TheAuthor" }) });
  assert.equal(run(dir1, "verify-owners.js", { PR_AUTHOR: "theauthor" }).code, 0);

  const dir2 = makeRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "theauthor" }) });
  assert.equal(run(dir2, "verify-owners.js", { PR_AUTHOR: "THEAUTHOR" }).code, 0);

  const dir3 = makeRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "tHeAuThOr" }) });
  assert.equal(run(dir3, "verify-owners.js", { PR_AUTHOR: "ThEaUtHoR" }).code, 0);

  const dir4 = makeRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "@TheAuthor" }) });
  assert.equal(run(dir4, "verify-owners.js", { PR_AUTHOR: "theauthor" }).code, 0);

  const dir5 = makeRegistry({ "web.is-a.ceo.json": labelled("web", { owner: { username: "TheAuthor" } }) });
  assert.equal(run(dir5, "verify-owners.js", { PR_AUTHOR: "theauthor" }).code, 0);
});

test("verify-owners allows maintainers to edit any entry", () => {
  const dir = makeRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "regular-user" }) });
  assert.equal(run(dir, "verify-owners.js", { PR_AUTHOR: "dikaardnt" }).code, 0);
});

test("verify-owners rejects rewriting an existing entry to a new owner", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "original-owner" }) }, (root) => {
    const target = path.join(root, "domains", "web.is-a.ceo.json");
    const entry = JSON.parse(fs.readFileSync(target, "utf8"));
    entry.owner = "attacker";
    fs.writeFileSync(target, JSON.stringify(entry, null, 2));
    gitRun(root, ["commit", "-qam", "take over"]);
  });
  const { code, out } = run(dir, "verify-owners.js", { PR_AUTHOR: "attacker", GITHUB_BASE_REF: "main" });
  assert.equal(code, 1);
  assert.match(out, /cannot be reassigned/);
});

test("verify-owners lets an owner update their own records", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "original-owner" }) }, (root) => {
    const target = path.join(root, "domains", "web.is-a.ceo.json");
    const entry = JSON.parse(fs.readFileSync(target, "utf8"));
    entry.records = { CNAME: ["moved.example.com"] };
    fs.writeFileSync(target, JSON.stringify(entry, null, 2));
    gitRun(root, ["commit", "-qam", "move"]);
  });
  assert.equal(run(dir, "verify-owners.js", { PR_AUTHOR: "original-owner", GITHUB_BASE_REF: "main" }).code, 0);
});

test("the report explains a takeover instead of a blank failure", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "original-owner" }) }, (root) => {
    const target = path.join(root, "domains", "web.is-a.ceo.json");
    const entry = JSON.parse(fs.readFileSync(target, "utf8"));
    entry.owner = "attacker";
    fs.writeFileSync(target, JSON.stringify(entry, null, 2));
    gitRun(root, ["commit", "-qam", "take over"]);
  });
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "pr-report.js")], {
    encoding: "utf8",
    cwd: dir,
    env: {
      ...process.env,
      PR_AUTHOR: "attacker",
      PR_NUMBER: "9",
      CHANGED_FILES: JSON.stringify(["domains/web.is-a.ceo.json"]),
      GITHUB_BASE_REF: "main",
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /already belongs to "original-owner"/);
  assert.match(result.stdout, /Only a maintainer can transfer a name/);
});

test("CNAME target with a trailing dot passes validation", () => {
  const entry = labelled("trailing", {
    records: { CNAME: ["trailing.vercel-dns-017.com."] },
  });
  assert.equal(accepts({ "trailing.is-a.ceo.json": entry }).code, 0);
});

test("CNAME specified as a string passes validation", () => {
  const entry = labelled("example", {
    records: { CNAME: "example.vercel-dns-017.com" },
  });
  assert.equal(accepts({ "example.is-a.ceo.json": entry }).code, 0);
});

test("CNAME with multiple targets is rejected", () => {
  const entry = labelled("multi", {
    records: { CNAME: ["target1.example.com", "target2.example.com"] },
  });
  rejects({ "multi.is-a.ceo.json": entry }, /only have a single target/);
});

test("self-referencing CNAME target is rejected", () => {
  const entry = labelled("loop", {
    records: { CNAME: ["loop.is-a.ceo"] },
  });
  rejects({ "loop.is-a.ceo.json": entry }, /cannot point to itself/);
});

test("CNAME target pointing to zone apex is rejected", () => {
  const entry = labelled("apexloop", {
    records: { CNAME: ["is-a.ceo."] },
  });
  rejects({ "apexloop.is-a.ceo.json": entry }, /cannot point to itself or the zone apex/);
});

test("domain file placed in repository root is rejected", () => {
  const dir = makeRegistry({});
  fs.writeFileSync(path.join(dir, "misplaced.is-a.ceo.json"), JSON.stringify(labelled("misplaced")));
  const { code, out } = run(dir, "validate.js");
  assert.equal(code, 1);
  assert.match(out, /must be placed in the domains\/ directory/);
});

test("the real registry in this repository passes", () => {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, "validate.js")], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /verified/);
});

function runJson(dir, script, env) {
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", script), "--json"], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: result.status, payload: JSON.parse(result.stdout || "{}") };
}

test("every problem in one file is reported at once", () => {
  const { code, payload } = runJson(makeRegistry({ "jh.is-a.ceo.json": { owner: { username: "FionyBot" } } }), "validate.js");
  assert.equal(code, 1);
  const messages = payload.problems.map((p) => p.message).join("\n");
  assert.match(messages, /missing "domain"/);
  assert.match(messages, /missing "subdomain"/);
  assert.match(messages, /"owner" must be a plain username string/);
});

test("one broken file does not hide problems in another", () => {
  const { payload } = runJson(
    makeRegistry({
      "one.is-a.ceo.json": { owner: { username: "a" } },
      "two.is-a.ceo.json": { domain: "is-a.ceo", subdomain: "two", owner: "b", records: { A: ["10.0.0.1"] } },
    }),
    "validate.js",
  );
  const files = new Set(payload.problems.map((p) => p.file));
  assert.ok(files.has("one.is-a.ceo.json"));
  assert.ok(files.has("two.is-a.ceo.json"));
});

test("an owner written as an object gets a concrete rewrite", () => {
  const { payload } = runJson(makeRegistry({ "jh.is-a.ceo.json": { owner: { username: "FionyBot" } } }), "validate.js");
  const message = payload.problems.map((p) => p.message).join("\n");
  assert.match(message, /"owner": "FionyBot"/);
});

test("a registry entry missing the .json extension is reported", () => {
  const dir = makeRegistry({});
  fs.writeFileSync(path.join(dir, "domains", "stray.is-a.ceo"), JSON.stringify(labelled("stray")));
  const { code, payload } = runJson(dir, "validate.js");
  assert.equal(code, 1);
  assert.match(payload.problems.map((p) => p.message).join("\n"), /rename it to "stray\.is-a\.ceo\.json"/);
});

test("a non-JSON file that is not an entry is left alone", () => {
  const dir = makeRegistry({ "ok.is-a.ceo.json": labelled("ok") });
  fs.rmSync(dir, { recursive: true, force: true });
  const fresh = makeRegistry({ "ok.is-a.ceo.json": labelled("ok") });
  fs.writeFileSync(path.join(fresh, "domains", "NOTES.md"), "hello");
  const { code } = runJson(fresh, "validate.js");
  assert.equal(code, 0);
});

test("a CNAME sharing its name with TXT is a warning, not a failure", () => {
  const entry = labelled("ornzora", { records: { CNAME: ["ornzora.vercel.app"], TXT: ["vc-domain-verify=x"] } });
  const { code, payload } = runJson(makeRegistry({ "ornzora.is-a.ceo.json": entry }), "validate.js");
  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.match(payload.warnings.map((w) => w.message).join("\n"), /_vercel\.ornzora/);
});

test("--json output is a single object with ok, verified, problems and warnings", () => {
  const { payload } = runJson(makeRegistry({ "mc.is-a.ceo.json": labelled("mc") }), "validate.js");
  assert.deepEqual(Object.keys(payload).sort(), ["ok", "problems", "verified", "warnings"]);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.verified, ["mc.is-a.ceo.json"]);
});

function runReport(files, env) {
  const dir = makeRegistry(files);
  const validate = spawnSync(process.execPath, [path.join(dir, "scripts", "validate.js"), "--json"], {
    encoding: "utf8",
    cwd: dir,
  });
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "render-report.js")], {
    encoding: "utf8",
    cwd: dir,
    input: validate.stdout,
    env: { ...process.env, ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return result.stdout;
}

test("the report explains a failure and shows a valid example", () => {
  const markdown = runReport({ "jh.is-a.ceo.json": { owner: { username: "FionyBot" } } }, { PR_AUTHOR: "FionyBot" });
  assert.match(markdown, /<!-- registry-validator -->/);
  assert.match(markdown, /## Registry check failed/);
  assert.match(markdown, /What a valid file looks like/);
  assert.match(markdown, /"subdomain": "jh"/);
  assert.match(markdown, /"owner": "your-github-username"/);
});

test("the report is quiet about a clean entry", () => {
  const markdown = runReport({ "mc.is-a.ceo.json": labelled("mc") }, {});
  assert.match(markdown, /## Registry check passed/);
  assert.match(markdown, /A maintainer still has to review/);
});

test("the report escalates a CNAME plus TXT entry", () => {
  const entry = labelled("ornzora", { records: { CNAME: ["ornzora.vercel.app"], TXT: ["vc-domain-verify=x"] } });
  const markdown = runReport({ "ornzora.is-a.ceo.json": entry }, {});
  assert.match(markdown, /one change needed before merge/);
  assert.match(markdown, /_vercel\.ornzora/);
});

test("the report never leaves an unresolved link", () => {
  const markdown = runReport({ "mc.is-a.ceo.json": labelled("mc") }, {});
  assert.doesNotMatch(markdown, /\]\(\.\//);
});

for (const name of ["me", "we", "they", "you", "us", "him", "her", "them", "anyone", "someone"]) {
  test(`a pronoun claim "${name}" is rejected without being listed by hand`, () => {
    rejects({ [`${name}.is-a.ceo.json`]: labelled(name) }, /is a pronoun, and this registry keeps those names unclaimed/);
  });
}

test("a pronoun is caught through leetspeak and repeated letters", () => {
  for (const variant of ["m3", "y0u", "th3y", "meee"]) {
    rejects({ [`${variant}.is-a.ceo.json`]: labelled(variant) }, /keeps those names unclaimed/);
  }
});

test("the classifier normalizes case, leetspeak and padding on its own", () => {
  const { classifyLabel } = require(path.join(SCRIPTS, "name-classes.js"));
  for (const variant of ["ME", "M3", "m3", "y0u", "th3y", "meee", "M.E", "we-"]) {
    assert.equal(classifyLabel(variant, ["pronoun"])?.name, "pronoun", variant);
  }
  assert.equal(classifyLabel("soudayonee", ["pronoun"]), null);
});

test("a determiner or grammar word is caught by class", () => {
  const dir = makeRegistry({ "the.is-a.ceo.json": labelled("the") });
  const metaPath = path.join(dir, "domains", "_meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta._meta.namePolicy.reservedClasses = ["pronoun", "determiner", "function-word"];
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  const { code, out } = run(dir, "validate.js");
  assert.equal(code, 1);
  assert.match(out, /is a determiner/);
});

test("a generic word passes but carries an advisory warning", () => {
  const { code, payload } = runJson(makeRegistry({ "blog.is-a.ceo.json": labelled("blog") }), "validate.js");
  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.match(payload.warnings.map((w) => w.message).join("\n"), /is a generic word/);
});

test("an ordinary personal handle is left alone", () => {
  const { code, payload } = runJson(makeRegistry({ "soudayonee.is-a.ceo.json": labelled("soudayonee") }), "validate.js");
  assert.equal(code, 0);
  assert.equal(payload.problems.length, 0);
  assert.equal(payload.warnings.length, 0);
});

test("an empty name policy disables the class check", () => {
  const dir = makeRegistry({ "me.is-a.ceo.json": labelled("me") });
  const metaPath = path.join(dir, "domains", "_meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta._meta.namePolicy = { reservedClasses: [], advisoryClasses: [] };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  const { code } = run(dir, "validate.js");
  assert.equal(code, 0);
});

test("the real _meta.json reserves the pronoun paradigm", () => {
  const meta = JSON.parse(fs.readFileSync(path.join(REPO, "domains", "_meta.json"), "utf8"))._meta;
  assert.deepEqual(meta.namePolicy.reservedClasses, ["pronoun", "determiner", "function-word"]);
  assert.deepEqual(meta.namePolicy.advisoryClasses, ["generic-noun"]);
});

test("two names owned by different people cannot share a CNAME target", () => {
  const out = rejects(
    {
      "first.is-a.ceo.json": labelled("first", { owner: "owner-a", records: { CNAME: ["same.vercel-dns-017.com"] } }),
      "second.is-a.ceo.json": labelled("second", { owner: "owner-b", records: { CNAME: ["same.vercel-dns-017.com"] } }),
    },
    /cannot serve one site/,
  );
  assert.match(out, /first\.is-a\.ceo/);
  assert.match(out, /second\.is-a\.ceo/);
});

test("a trailing dot does not hide a shared CNAME target", () => {
  rejects(
    {
      "first.is-a.ceo.json": labelled("first", { owner: "owner-a", records: { CNAME: ["same.vercel-dns-017.com."] } }),
      "second.is-a.ceo.json": labelled("second", { owner: "owner-b", records: { CNAME: ["SAME.vercel-dns-017.com"] } }),
    },
    /cannot serve one site/,
  );
});

test("two names with their own targets are accepted", () => {
  const { code } = accepts({
    "first.is-a.ceo.json": labelled("first", { owner: "owner-a", records: { CNAME: ["a.vercel-dns-017.com"] } }),
    "second.is-a.ceo.json": labelled("second", { owner: "owner-b", records: { CNAME: ["b.vercel-dns-017.com"] } }),
  });
  assert.equal(code, 0);
});

test("two names owned by different people cannot share an A record either", () => {
  rejects(
    {
      "first.is-a.ceo.json": labelled("first", { owner: "owner-a", records: { A: ["75.2.60.5"] } }),
      "second.is-a.ceo.json": labelled("second", { owner: "owner-b", records: { A: ["75.2.60.5"] } }),
    },
    /cannot serve one site/,
  );
});

test("verify-owners rejects deleting an entry owned by someone else", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "original-owner" }) }, (root) => {
    gitRun(root, ["rm", "-q", "domains/web.is-a.ceo.json"]);
    gitRun(root, ["commit", "-qam", "delete"]);
  });
  const { code, out } = run(dir, "verify-owners.js", { PR_AUTHOR: "attacker", GITHUB_BASE_REF: "main" });
  assert.equal(code, 1);
  assert.match(out, /cannot delete an entry owned by someone else/);
  assert.match(out, /original-owner/);
});

test("verify-owners lets an owner delete their own entry", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "original-owner" }) }, (root) => {
    gitRun(root, ["rm", "-q", "domains/web.is-a.ceo.json"]);
    gitRun(root, ["commit", "-qam", "delete"]);
  });
  assert.equal(run(dir, "verify-owners.js", { PR_AUTHOR: "original-owner", GITHUB_BASE_REF: "main" }).code, 0);
});

test("a self-promotion in _meta.json does not grant maintainer rights", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "original-owner" }) }, (root) => {
    const metaPath = path.join(root, "domains", "_meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta._meta.maintainers.push("attacker");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const target = path.join(root, "domains", "web.is-a.ceo.json");
    const entry = JSON.parse(fs.readFileSync(target, "utf8"));
    entry.owner = "attacker";
    fs.writeFileSync(target, JSON.stringify(entry, null, 2));
    gitRun(root, ["commit", "-qam", "promote then take over"]);
  });
  const { code, out } = run(dir, "verify-owners.js", { PR_AUTHOR: "attacker", GITHUB_BASE_REF: "main" });
  assert.equal(code, 1);
  assert.match(out, /cannot be reassigned/);
});

test("a non-maintainer cannot loosen the reserved list through _meta.json", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "someone" }) }, (root) => {
    const metaPath = path.join(root, "domains", "_meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta._meta.reserved = meta._meta.reserved.filter((r) => r !== "admin");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    gitRun(root, ["commit", "-qam", "unreserve admin"]);
  });
  const { code, out } = run(dir, "validate.js", { PR_AUTHOR: "someone", GITHUB_BASE_REF: "main" });
  assert.equal(code, 1);
  assert.match(out, /drops "admin" from "reserved"/);
});

test("a non-maintainer cannot add themselves to maintainers", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "someone" }) }, (root) => {
    const metaPath = path.join(root, "domains", "_meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta._meta.maintainers.push("someone");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    gitRun(root, ["commit", "-qam", "self promote"]);
  });
  const { code, out } = run(dir, "validate.js", { PR_AUTHOR: "someone", GITHUB_BASE_REF: "main" });
  assert.equal(code, 1);
  assert.match(out, /only an existing maintainer can grant that/);
});

test("a maintainer may still loosen the name policy", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "someone" }) }, (root) => {
    const metaPath = path.join(root, "domains", "_meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta._meta.reserved = meta._meta.reserved.filter((r) => r !== "admin");
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    gitRun(root, ["commit", "-qam", "unreserve admin"]);
  });
  assert.equal(run(dir, "validate.js", { PR_AUTHOR: "dikaardnt", GITHUB_BASE_REF: "main" }).code, 0);
});

test("an untouched _meta.json raises nothing", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "someone" }) }, (root) => {
    fs.writeFileSync(path.join(root, "domains", "web.is-a.ceo.json"), JSON.stringify(labelled("web", { owner: "someone", description: "edited" }), null, 2));
    gitRun(root, ["commit", "-qam", "touch the entry"]);
  });
  assert.equal(run(dir, "validate.js", { PR_AUTHOR: "someone", GITHUB_BASE_REF: "main" }).code, 0);
});
