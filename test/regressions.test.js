"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const REPO = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO, "scripts");

const { checkFormat } = require(path.join(SCRIPTS, "check-format.js"));
const { renderReport, exampleFor, subdomainFromFile } = require(path.join(SCRIPTS, "render-report.js"));
const { runDnsconfig } = require("./dnsconfig-harness.js");

const META = {
  _meta: {
    provider: "cloudflare",
    maxLength: 63,
    zones: ["is-a.ceo"],
    maintainers: ["hisokalabs", "dikaardnt", "daningl"],
    reserved: ["api", "admin", "mail", "status", "dev", "is-a"],
    blocked: ["abuse", "security", "paypal", "github", "gmail"],
    namePolicy: { reservedClasses: ["pronoun"], advisoryClasses: ["generic-noun"] },
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

function makeRegistry(files, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regression-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const name of fs.readdirSync(SCRIPTS)) {
    fs.copyFileSync(path.join(SCRIPTS, name), path.join(dir, "scripts", name));
  }
  if (options.withDnsconfig) {
    fs.copyFileSync(path.join(REPO, "dnsconfig.js"), path.join(dir, "dnsconfig.js"));
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  const domains = path.join(dir, "domains");
  fs.mkdirSync(domains);
  fs.writeFileSync(path.join(domains, "_meta.json"), JSON.stringify(META, null, 2));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(domains, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    fs.writeFileSync(target, text);
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

function runJson(dir, script, env) {
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", script), "--json"], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: result.status, payload: JSON.parse(result.stdout || "{}") };
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
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stderr}`);
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

test("a registry entry in a subdirectory is refused", () => {
  // dnsconfig.js walked domains/ recursively while validate.js read one level,
  // so a nested file reached Cloudflare without being checked.
  const dir = makeRegistry({});
  fs.mkdirSync(path.join(dir, "domains", "nested"));
  fs.writeFileSync(
    path.join(dir, "domains", "nested", "admin.is-a.ceo.json"),
    JSON.stringify({ domain: "is-a.ceo", subdomain: "admin", owner: "attacker", records: { A: ["8.8.8.8"] } }),
  );
  const { code, out } = run(dir, "validate.js");
  assert.equal(code, 1);
  assert.match(out, /contains a subdirectory/);
});

test("dnsconfig.js ignores files in a subdirectory", () => {
  const dir = makeRegistry({ "ok.is-a.ceo.json": labelled("ok") }, { withDnsconfig: true });
  fs.mkdirSync(path.join(dir, "domains", "nested"));
  fs.writeFileSync(
    path.join(dir, "domains", "nested", "evil.evil.example.json"),
    JSON.stringify({ domain: "evil.example", subdomain: "x", owner: "attacker", records: { A: ["8.8.8.8"] } }),
  );
  const result = runDnsconfig(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.error, null, result.error);
  assert.deepEqual(Object.keys(result.zones), ["is-a.ceo"]);
  assert.equal(result.zones["is-a.ceo"].length, 1);
});

test("dnsconfig.js refuses a zone that _meta.json does not list", () => {
  const dir = makeRegistry({ "ok.is-a.ceo.json": labelled("ok") }, { withDnsconfig: true });
  const entryPath = path.join(dir, "domains", "ok.is-a.ceo.json");
  const entry = JSON.parse(fs.readFileSync(entryPath, "utf8"));
  entry.domain = "not-managed.example";
  fs.writeFileSync(entryPath, JSON.stringify(entry, null, 2));
  const result = runDnsconfig(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(result.error || "", /unmanaged zones/);
  assert.equal(result.zones["not-managed.example"], undefined);
});

test("a domain file in the repository root is reported even when it parses", () => {
  // fail() used to throw inside the try/catch that swallowed errors, so a root
  // file with a two-part name passed silently.
  const dir = makeRegistry({});
  fs.writeFileSync(path.join(dir, "sneaky.json"), JSON.stringify(labelled("sneaky")));
  const { code, out } = run(dir, "validate.js");
  assert.equal(code, 1);
  assert.match(out, /must be placed in the domains\/ directory/);
});

test("a symlinked entry is refused without being read", () => {
  const dir = makeRegistry({ "ok.is-a.ceo.json": labelled("ok") });
  const target = path.join(dir, "outside.txt");
  fs.writeFileSync(target, "secret material that must not be echoed");
  try {
    fs.symlinkSync(target, path.join(dir, "domains", "link.is-a.ceo.json"));
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return; // symlink creation needs a privilege this platform may withhold
  }
  const { code, out } = run(dir, "validate.js");
  assert.equal(code, 1);
  assert.match(out, /must be regular files/);
  assert.doesNotMatch(out, /secret material/);
});

test("an invalid JSON error does not echo the file contents", () => {
  // The parser quotes the input, and this text is posted in a public comment.
  const dir = makeRegistry({ "leak.is-a.ceo.json": '{ "owner": "sk_live_51H8xQ2KZ9" oops' });
  const { code, out } = run(dir, "validate.js");
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(out, /invalid JSON/);
  assert.doesNotMatch(out, /sk_live_51H8xQ2KZ9/);
});

test("an owner written two ways counts as one claim", () => {
  rejects(
    {
      "one.is-a.ceo.json": labelled("one", { owner: "same" }),
      "two.is-a.ceo.json": labelled("two", { owner: "@Same" }),
    },
    /already has one\.is-a\.ceo/,
  );
});

test("a control character in owner is refused", () => {
  rejects({ "web.is-a.ceo.json": labelled("web", { owner: "bad\u0007name" }) }, /control character|invalid JSON/);
});

test("the 39-character owner limit ignores the leading @", () => {
  const handle = "a".repeat(39);
  assert.equal(
    accepts({ "web.is-a.ceo.json": labelled("web", { owner: `@${handle}` }) }).code,
    0,
  );
  rejects({ "web.is-a.ceo.json": labelled("web", { owner: "a".repeat(40) }) }, /longer than 39/);
});

test("an empty record array is refused", () => {
  rejects({ "web.is-a.ceo.json": labelled("web", { records: { A: [] } }) }, /empty array/);
});

test("a record type over the count limit is refused", () => {
  const many = Array.from({ length: 21 }, (_, i) => `10.0.${i}.1`);
  rejects({ "web.is-a.ceo.json": labelled("web", { records: { A: many } }) }, /the limit is 20/);
});

test("a CAA issue value must be a bare domain", () => {
  rejects(
    {
      "web.is-a.ceo.json": labelled("web", {
        records: { CAA: [{ flag: 0, tag: "issue", value: "https://letsencrypt.org" }] },
      }),
    },
    /bare domain/,
  );
});

test("a CAA iodef value may be a URL", () => {
  const entry = labelled("web", {
    records: {
      CNAME: ["web.example.com"],
      CAA: [{ flag: 0, tag: "iodef", value: "mailto:security@example.com" }],
    },
    proxied: true,
  });
  assert.equal(accepts({ "web.is-a.ceo.json": entry }).code, 0);
});

test("a CAA-only entry is still refused as pointing nowhere", () => {
  // CAA constrains who may issue a certificate for a name; on its own it gives
  // the name no address, so the entry is incomplete rather than a rule failure.
  rejects(
    { "web.is-a.ceo.json": labelled("web", { records: { CAA: [{ flag: 0, tag: "issue", value: "letsencrypt.org" }] } }) },
    /must define at least one of/,
  );
});

test("the same target in two zones is not a shared-target clash", () => {
  const dir = makeRegistry({});
  const metaPath = path.join(dir, "domains", "_meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  meta._meta.zones = ["is-a.ceo", "also.is-a.ceo"];
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  fs.writeFileSync(
    path.join(dir, "domains", "a.is-a.ceo.json"),
    JSON.stringify({ domain: "is-a.ceo", subdomain: "a", owner: "one", records: { CNAME: ["same.pages.dev"] } }),
  );
  fs.writeFileSync(
    path.join(dir, "domains", "b.also.is-a.ceo.json"),
    JSON.stringify({ domain: "also.is-a.ceo", subdomain: "b", owner: "two", records: { CNAME: ["same.pages.dev"] } }),
  );
  const { code, out } = run(dir, "validate.js");
  assert.equal(code, 0, out);
});

test("the shared-target report names the other owner", () => {
  const out = rejects({
    "first.is-a.ceo.json": labelled("first", { owner: "owner-a", records: { CNAME: ["same.vercel-dns-017.com"] } }),
    "second.is-a.ceo.json": labelled("second", { owner: "owner-b", records: { CNAME: ["same.vercel-dns-017.com"] } }),
  });
  assert.match(out, /@owner-b/);
});

test("a proxied CNAME with TXT is not warned about", () => {
  // DNSControl skips its coexistence check for a proxied CNAME, because
  // Cloudflare flattens the record and never serves a real CNAME.
  const entry = labelled("ornzora", {
    records: { CNAME: ["ornzora.vercel.app"], TXT: ["hello"] },
    proxied: true,
  });
  const { code, payload } = runJson(makeRegistry({ "ornzora.is-a.ceo.json": entry }), "validate.js");
  assert.equal(code, 0);
  assert.equal(payload.warnings.length, 0);
});

test("an unproxied CNAME with TXT is still warned about", () => {
  const entry = labelled("ornzora", {
    records: { CNAME: ["ornzora.vercel.app"], TXT: ["hello"] },
  });
  const { code, payload } = runJson(makeRegistry({ "ornzora.is-a.ceo.json": entry }), "validate.js");
  assert.equal(code, 0);
  assert.equal(payload.warnings.length, 1);
});

test("verify-owners passes when the PR touches no registry file", () => {
  // The empty diff used to be read as "git failed", which fell back to checking
  // every entry and failed every docs-only PR for a non-maintainer.
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "someone" }) }, (root) => {
    fs.writeFileSync(path.join(root, "README.md"), "docs only\n");
    gitRun(root, ["add", "-A"]);
    gitRun(root, ["commit", "-q", "-m", "docs"]);
  });
  const { code, out } = run(dir, "verify-owners.js", { PR_AUTHOR: "stranger", GITHUB_BASE_REF: "main" });
  assert.equal(code, 0, out);
  assert.match(out, /no registry files changed/);
});

test("verify-owners still catches a takeover after a file move", { skip: !gitAvailable() }, () => {
  const dir = makeGitRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "original-owner" }) }, (root) => {
    gitRun(root, ["mv", "domains/web.is-a.ceo.json", "domains/taken.is-a.ceo.json"]);
    const target = path.join(root, "domains", "taken.is-a.ceo.json");
    const entry = JSON.parse(fs.readFileSync(target, "utf8"));
    entry.subdomain = "taken";
    entry.owner = "attacker";
    fs.writeFileSync(target, JSON.stringify(entry, null, 2));
    gitRun(root, ["commit", "-q", "-m", "move and take"]);
  });
  const { code, out } = run(dir, "verify-owners.js", { PR_AUTHOR: "attacker", GITHUB_BASE_REF: "main" });
  assert.equal(code, 1);
  assert.match(out, /cannot delete an entry owned by someone else/);
});

test("the validator refuses to pass blind only when the caller asks it to", { skip: !gitAvailable() }, () => {
  // check.yml sets REQUIRE_BASE_REF=1, because there the comparison is the guard
  // against a non-maintainer rewriting _meta.json. registry-comment.yml restores
  // _meta.json from the base branch first, so it opts out with no env.
  const dir = makeRegistry({ "web.is-a.ceo.json": labelled("web", { owner: "someone" }) });
  gitRun(dir, ["init", "-q", "-b", "trunk"]);
  gitRun(dir, ["add", "-A"]);
  gitRun(dir, ["commit", "-q", "-m", "base"]);

  const validate = (env) =>
    spawnSync(process.execPath, [path.join(dir, "scripts", "validate.js")], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, ...env },
    });

  const strict = validate({ PR_AUTHOR: "someone", REQUIRE_BASE_REF: "1", GITHUB_BASE_REF: "no-such-branch" });
  const lenient = validate({ PR_AUTHOR: "someone", GITHUB_BASE_REF: "no-such-branch" });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  assert.match(`${strict.stdout}${strict.stderr}`, /could not be read/);
  assert.equal(lenient.status, 0, lenient.stdout + lenient.stderr);
});

test("a contributor PR cannot touch the DNS config", () => {
  const problems = checkFormat(
    [
      { status: "M", path: "domains/jane.is-a.ceo.json" },
      { status: "M", path: "dnsconfig.js" },
    ],
    { isMaintainer: false },
  );
  assert.match(problems.map((p) => p.message).join("\n"), /only a maintainer can change the validator/);
});

test("a contributor PR cannot touch _meta.json", () => {
  const problems = checkFormat([{ status: "M", path: "domains/_meta.json" }], { isMaintainer: false });
  assert.match(problems.map((p) => p.message).join("\n"), /only a maintainer can change this file/);
});

test("a claim PR may add its own entry and Vercel sidecar", () => {
  const problems = checkFormat(
    [
      { status: "A", path: "domains/jane.is-a.ceo.json" },
      { status: "A", path: "domains/_vercel.jane.is-a.ceo.json" },
    ],
    { isMaintainer: false },
  );
  assert.deepEqual(problems, []);
});

test("a claim PR touching five entries is refused", () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ status: "A", path: `domains/n${i}.is-a.ceo.json` }));
  const problems = checkFormat(files, { isMaintainer: false });
  assert.match(problems.map((p) => p.message).join("\n"), /touches 5 files under domains\//);
});

test("a maintainer may change dnsconfig.js and _meta.json", () => {
  const problems = checkFormat(
    [
      { status: "M", path: "dnsconfig.js" },
      { status: "M", path: "domains/_meta.json" },
    ],
    { isMaintainer: true },
  );
  assert.deepEqual(problems, []);
});

test("a local run without an author does not apply the scope rules", () => {
  // npm run verify has no PR_AUTHOR. The scope rules ask "may this author touch
  // this path", which nobody can answer then, so they are skipped: a maintainer
  // working on the validator must not be told their own change is off limits.
  const problems = checkFormat(
    [
      { status: "M", path: "scripts/validate.js" },
      { status: "M", path: ".github/workflows/check.yml" },
    ],
    { isMaintainer: false, scope: false },
  );
  assert.deepEqual(problems, []);
});

test("a local run still checks the file rules it can answer", () => {
  const dir = makeRegistry({ "jh.is-a.ceo.json": { ...labelled("someone-else") } });
  const problems = checkFormat([{ status: "A", path: "domains/jh.is-a.ceo.json" }], {
    isMaintainer: false,
    scope: false,
    root: dir,
  });
  assert.match(problems.map((p) => p.message).join("\n"), /must be named/);
});

test("a claim file whose name disagrees with its contents is refused", () => {
  const dir = makeRegistry({ "jh.is-a.ceo.json": { ...labelled("someone-else") } });
  const problems = checkFormat([{ status: "A", path: "domains/jh.is-a.ceo.json" }], {
    isMaintainer: false,
    root: dir,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(problems.map((p) => p.message).join("\n"), /must be named/);
});

test("a claim file missing its final newline is refused", () => {
  const dir = makeRegistry({ "jh.is-a.ceo.json": JSON.stringify(labelled("jh")) });
  const problems = checkFormat([{ status: "M", path: "domains/jh.is-a.ceo.json" }], {
    isMaintainer: false,
    root: dir,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(problems.map((p) => p.message).join("\n"), /newline/);
});

test("a claim file indented with tabs is refused", () => {
  const dir = makeRegistry({ "jh.is-a.ceo.json": `{\n\t"domain": "is-a.ceo",\n\t"subdomain": "jh",\n\t"owner": "jh",\n\t"records": { "CNAME": ["jh.example.com"] }\n}\n` });
  const problems = checkFormat([{ status: "M", path: "domains/jh.is-a.ceo.json" }], {
    isMaintainer: false,
    root: dir,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(problems.map((p) => p.message).join("\n"), /two spaces/);
});

test("a correct claim file raises nothing", () => {
  const dir = makeRegistry({ "jh.is-a.ceo.json": labelled("jh") });
  const problems = checkFormat([{ status: "A", path: "domains/jh.is-a.ceo.json" }], {
    isMaintainer: false,
    root: dir,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(problems, []);
});

test("a contributor deleting a claim is refused", () => {
  const problems = checkFormat([{ status: "D", path: "domains/old.is-a.ceo.json" }], { isMaintainer: false });
  assert.match(problems.map((p) => p.message).join("\n"), /deleting a name is a maintainer action/);
});

test("the documented claim template passes the shape check", () => {
  const problems = checkFormat([{ status: "A", path: "domains/_example.json" }], { isMaintainer: false });
  assert.deepEqual(problems, []);
});

test("the report escapes mentions and HTML in contributor text", () => {
  const markdown = renderReport({
    report: {
      ok: false,
      verified: [],
      problems: [{ file: "x.is-a.ceo.json", message: 'x.is-a.ceo.json: owner "@victim" <!-- hide -->' }],
      warnings: [],
    },
    prAuthor: "attacker",
    prNumber: "7",
  });
  assert.doesNotMatch(markdown, /@victim/);
  assert.match(markdown, /&#64;victim/);
  assert.doesNotMatch(markdown, /<!-- hide/);
});

test("the report derives the zone from the file name", () => {
  assert.equal(subdomainFromFile("domains/jane.other.example.json"), "jane");
  assert.match(exampleFor("jane", "other.example"), /"domain": "other\.example"/);
});

test("status.js survives an empty registry", () => {
  const dir = makeRegistry({});
  const result = spawnSync(process.execPath, [path.join(dir, "scripts", "status.js")], {
    encoding: "utf8",
    cwd: dir,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no registry entries to probe/);
});

test("status.js refuses a redirect that leaves the host", () => {
  const source = fs.readFileSync(path.join(SCRIPTS, "status.js"), "utf8");
  // This guard is what stops a contributor-controlled redirect from making the
  // scheduled workflow fetch an arbitrary internal address.
  assert.match(source, /not followed/);
  assert.match(source, /hostOf\(next\) !== hostOf/);
});
