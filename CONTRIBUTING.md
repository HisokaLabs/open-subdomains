# Contributing to is-a.ceo

DNS zone is deployed by [HisokaLabs/dnscontrol-actions@v4](https://github.com/HisokaLabs/dnscontrol-actions).

## Claim a subdomain

1. Fork this repository and create a branch.
2. Copy [`domains/_example.json`](domains/_example.json) to
   `domains/<your-subdomain>.is-a.ceo.json` (for example `mc.is-a.ceo.json`).
   The filename must be exactly `<subdomain>.<zone>.json`.
3. Run `npm run check`, `npm test` and `npm run check:format` locally so you see
   the same verdict as CI.
4. Open a pull request against `main` and fill in the template. The `check`
   workflow validates the entry, confirms `owner` is your own GitHub username,
   and previews the DNS diff. The `format` workflow confirms the change is one
   claim and nothing else.
5. When it merges, the zone is pushed to Cloudflare within a minute or two.

### The file

```json
{
  "domain": "is-a.ceo",
  "subdomain": "jane",
  "owner": "jane",
  "email": "jane@example.com",
  "repo": "github.com/jane/jane.github.io",
  "description": "My Minecraft server",
  "records": {
    "A": ["8.8.4.4"],
    "SRV": [
      { "priority": 0, "weight": 5, "port": 25565, "target": "mc.example.com" }
    ]
  }
}
```

Two things in that example are deliberate. `8.8.4.4` stands in for whatever
public IPv4 address you host on: the documentation ranges (`203.0.113.0/24`,
`198.51.100.0/24`, `2001:db8::/32`) are rejected by the validator like any other
non-public address, so do not test with them. And the SRV target points at a
host outside this zone, because a service record that names the name it sits on
is a CNAME loop the moment anyone adds one.

| Field         | Required | Notes                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------- |
| `domain`      | yes      | The zone the subdomain belongs to; must be listed in `domains/_meta.json`. |
| `subdomain`   | yes      | See the shapes below.                                                      |
| `owner`       | yes      | Your GitHub username, so people can reach you.                            |
| `email`       | no       | Contact address like `you@example.com`. Optional, but the fastest way for maintainers to reach you. |
| `proxied`     | no       | Route through the Cloudflare proxy. Defaults to `false`, see below.      |
| `repo`        | no       | `owner/repo` or `github.com/owner/repo`. Shown on the site.               |
| `description` | no       | One line, shown on the site.                                              |
| `records`     | no       | Omit entirely to get the GitHub Pages default (see below).                |

### Subdomain shapes

The `subdomain` field and the filename (without the `.is-a.ceo.json` suffix)
must match exactly. All of these are valid:

| Shape                     | Filename                          | What it is for                                  |
| ------------------------- | --------------------------------- | ----------------------------------------------- |
| `mc`                      | `mc.is-a.ceo.json`                | A normal single-label subdomain.                 |
| `@`                       | `@.is-a.ceo.json`                 | The zone apex itself. Maintainers only.          |
| `*.go`                    | `*.go.is-a.ceo.json`              | A wildcard: anything under `.go` matches. You must already claim `go` yourself. |
| `_acme-challenge.app`     | `_acme-challenge.app.is-a.ceo.json` | DNS-01 certificate challenges and other `_` records. |

One note on wildcards: a `*.go` claim is only accepted when `go` in the same
zone is already claimed by the same owner: a wildcard must widen your own
name, never someone else's. The same rule covers underscore records such as
`_acme-challenge.go` and `_dmarc.go`, because whoever holds those can issue a
certificate for `go` or forge its mail policy. Service records are the
exception: a bare `_minecraft._tcp.mc` with only SRV data is open to anyone.
A bare zone-wide `*` is maintainer-only, since it would otherwise cover every
unclaimed name in the zone. The same holds for `@` and for any bare underscore
name at the zone root: `_acme-challenge.is-a.ceo` can answer a DNS-01 challenge
for `*.is-a.ceo`, `_dmarc.is-a.ceo` forges mail policy for the whole zone, and
`_vercel.is-a.ceo` is the ownership proof Vercel asks for when the zone is
already linked to another account. Put your own record one label deeper, e.g.
`_acme-challenge.app` or `_vercel.yourname`, where the base-claim rule above
applies. The filename contains `*`, which Windows cannot create on an NTFS
disk. If you develop on Windows, add wildcard entries through the GitHub web
interface instead of a local clone; CI runs on Linux, where it is fine.

### Pointing at Vercel

A Vercel project is attached with `CNAME: ["<hash>.vercel-dns-017.com"]`, or the
short form `cname.vercel-dns.com` when you start fresh. The hash Vercel prints on the
Domains panel replaces the short form, and it is what `dnscontrol push` publishes.

When the name is already linked to a **different** Vercel account, the panel adds a
banner and a second row:

```
TXT   _vercel   vc-domain-verify=<label>.is-a.ceo,<token>
```

The banner sentence says `add a TXT record at _vercel.is-a.ceo`. That sentence is the
zone, not the target. The row is the record, and it resolves to
`_vercel.<label>.is-a.ceo`. The registry only accepts the record: `validate.js` pins a
proof to the name it verifies, so a proof for `holder.is-a.ceo` counts on
`_vercel.holder.is-a.ceo` and nowhere else.

The proof cannot sit in your own file either. `holder.is-a.ceo` already carries a
CNAME, and DNS forbids a CNAME and a TXT on the same name, so `dnscontrol push` would
fail after merge. The proof gets its own entry, one label deeper, owned by you:

```bash
node scripts/vercel-proof.js --name holder --token <token>
```

That writes `domains/_vercel.holder.is-a.ceo.json`, checks it against the validator,
and prints the next three steps. `--proof "vc-domain-verify=holder.is-a.ceo,<token>"`
takes the whole line instead of just the token, `--list` shows every sidecar already in
the registry, and `--remove` deletes the sidecar and nothing else. Pass `--dry-run` to
see the file without writing it.

Commit the two files together: your own `<label>.is-a.ceo.json` (if you are claiming
the name in the same PR) and `_vercel.<label>.is-a.ceo.json` (if Vercel already shows
the banner). After the merge and the DNS push, press Verify in Vercel, wait for
**Valid Configuration**, then run `--remove` in a second PR. The TXT is only needed
until the domain is attached; deleting it afterwards does not detach anything.

A dotted name whose first label starts with `_` is an **auxiliary** entry: it is
exempt from the one-name-per-person quota and from the base-claim rule, and its owner
must still be your own GitHub username. `verify-owners.js` checks that like any other
file, so a sidecar for someone else's name is refused.

A CNAME cannot share a name with any other record type: no `A`, `AAAA`, `MX`,
`NS`, `SRV`, or `PTR` next to it. That is a DNS rule, not a registry one.
`TXT` and `CAA` are the two that may sit alongside a CNAME.

An entry does not have to point anywhere with A/AAAA/CNAME. A delegation
(`NS` only), a mail route (`MX` only), a service record (`SRV` only), a
reverse record (`PTR` only), and a bare verification record (`TXT` only) are
all accepted on their own.

Single-label claims are checked against the reserved and blocked lists in
`domains/_meta.json`. Dotted, wildcard, and apex names skip that check
because they are specific already.

### What your pull request may contain

One claim, one file. A pull request adds `domains/<subdomain>.<zone>.json`, plus
`domains/_vercel.<name>.<zone>.json` if Vercel asked for a proof. Five checks
enforce that shape:

| Rule | Why |
| --- | --- |
| Only files in `domains/`, plus the documentation. | A claim and a validator change are reviewed differently and revert differently. |
| `dnsconfig.js`, `scripts/`, `test/`, `.github/`, `domains/_meta.json` and `domains/SCHEMA.json` are maintainer-only. | Those decide what everyone else may claim. |
| At most four files under `domains/`. | One claim plus its Vercel sidecar is the real maximum. |
| The file name matches the `subdomain` and `domain` inside it. | The filename is what the reviewer reads first. |
| Two-space indent and a final newline. | Keeps `git diff` readable. |

Deleting an entry is a maintainer action, even your own: ask a maintainer to
release the name. Editing your own entry to change its records is fine.


The label also has to be a name, not a word. Pronouns (`me`, `we`, `they`,
`you`, `us`, `him`, `her`, `them`), determiners (`the`, `this`, `any`,
`every`), and grammar words (`and`, `if`, `not`, `what`) are refused by the
kind of word they are, so no list has to grow to keep up with them. The rule
lives in `scripts/name-classes.js` and is enabled per class in
`namePolicy.reservedClasses`, so a new class of generic word is one entry
away. Leetspeak and doubled letters do not dodge it: `M3`, `m3`, and `meee`
all resolve to `me`.

Generic vocabulary (`home`, `blog`, `app`, `shop`, `docs`) is not refused,
because a few of those read as a real handle. It raises an advisory warning
instead, and a maintainer will almost always ask for your GitHub handle,
since a shared word can only be claimed once.

Pick the label that matches the GitHub account the record points at. That is
the only name no one else can make a claim to.

Records must point at the public internet: A/AAAA have to be public IPs
(loopback, RFC 1918, link-local, CGNAT, and other internal ranges are
rejected, because a public name pointing into a private network is a DNS-rebinding
setup), and CNAME/MX/NS/SRV/PTR targets have to be real public hostnames
(`localhost`, `.local`, `.home.arpa`, and friends are rejected).

The full machine-readable definition is
[domains/SCHEMA.json](domains/SCHEMA.json) (JSON Schema draft-07). It is served
live at <https://is-a.ceo/domains.schema.json> and carries that URL as its `$id`,
so the copy in this repository and the copy on the website are the same
document. Editors with a JSON Schema extension pick it up automatically when you
add this to the top of your file:

```json
{
  "$schema": "./SCHEMA.json",
  "domain": "is-a.ceo",
  "subdomain": "mc",
  "owner": "your-github-username"
}
```

### Supported records

`A`, `AAAA`, `CNAME`, `TXT`, `MX`, `NS`, `SRV`, `CAA`, `PTR`. All values are
arrays, so you can have several of one type. Examples:

```json
"records": {
  "A":    ["8.8.4.4", "1.1.1.1"],
  "AAAA": ["2606:4700:4700::1111"],
  "TXT":  ["v=spf1 include:_spf.google.com -all"],
  "MX":   [{ "priority": 10, "target": "mx.example.com" }],
  "NS":   ["ns1.example.com", "ns2.example.com"],
  "SRV":  [{ "priority": 0, "weight": 5, "port": 25565, "target": "mc.example.com" }],
  "CAA":  [{ "flag": 0, "tag": "issue", "value": "letsencrypt.org" }]
}
```

These are separate record *types*, not one entry: a single file holds the types
for its own name. `CNAME` appears on its own because it cannot share a name with
`A`, `AAAA`, `MX`, `NS`, `SRV` or `PTR`:

```json
"records": {
  "CNAME": ["your-project.pages.dev"]
}
```

An apex (`@`) entry cannot use `CNAME`; use `A`/`AAAA` there. `TXT` and `CAA`
may sit next to a CNAME only when the entry is `"proxied": true`; on an
unproxied CNAME, DNSControl rejects the pair and the push fails.

### The Cloudflare proxy

Setting `"proxied": true` sends your traffic through Cloudflare (hides the
origin IP, gets their WAF). It defaults to `false` because proxying breaks
GitHub Pages' HTTPS certificate issuance, so leave it off unless you know your
host works behind the proxy.

### The default

If you leave `records` out, your subdomain gets GitHub Pages automatically:

```
A     185.199.108.153  185.199.109.153  185.199.110.153  185.199.111.153
AAAA  2606:50c1:8000::153 2606:50c1:8001::153 2606:50c1:8002::153 2606:50c1:8003::153
```

That means `your-name.is-a.ceo` serves `your-name.github.io` the moment the PR
merges, with zero configuration on your side.

## Rules

- One subdomain per person per purpose. Don't squat, don't hoard. CI enforces
  this: a second entry with the same `owner` in the same zone fails the build.
  The `@` entry does not count, it is the zone itself, not a claim.
- The `owner` field must be **your** GitHub username, and the pull request must
  be opened by you. CI checks that the PR author matches every `owner` in the
  files the PR touches.
- No malware, phishing, or content that would get the whole zone delisted.
- Keep it legal in the Netherlands, where the zone is hosted.
- Don't edit `dnsconfig.js` to add a subdomain, it reads `domains/*.json`
  directly, so your PR only touches your own file.
- Don't touch another person's file without asking them first.

Names like `admin`, `mail`, `api` and anything impersonating a well-known
brand are reserved or blocked; the validator will tell you if you picked one.
You can check any name in a browser first at
[is-a.ceo/check](https://is-a.ceo/check), no PR needed to find out.

### Redirects

The zone is DNS-only, so there is no built-in redirect record. To send
`your-name.is-a.ceo` somewhere else over HTTP, host the redirect yourself:
point a `CNAME` at GitHub Pages and add an HTML meta refresh, or use your own
host's redirect feature. DNS can only send a visitor to an address, not rewrite
the path.

## Abuse

Report abuse to [abuse@hisoka.net](mailto:abuse@hisoka.net). The full
policy and what happens after a report is published at
[is-a.ceo/abuse](https://is-a.ceo/abuse).
