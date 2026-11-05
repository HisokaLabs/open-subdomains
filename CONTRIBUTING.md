# Contributing to is-a.ceo

DNS zone is deployed by [HisokaLabs/dnscontrol-actions@v4](https://github.com/HisokaLabs/dnscontrol-actions).

## Claim a subdomain

DNS zone is deployed by [HisokaLabs/dnscontrol-actions@v4](https://github.com/HisokaLabs/dnscontrol-actions).

1. Fork this repository and create a branch.
2. Copy [`domains/_example.json`](domains/_example.json) to
   `domains/<your-subdomain>.is-a.ceo.json` (for example `mc.is-a.ceo.json`).
   The filename must be exactly `<subdomain>.<zone>.json`.
3. Run `npm run check` and `npm test` locally so you see the same verdict as CI.
4. Open a pull request against `main` and fill in the template. The `check`
   workflow validates the entry, confirms `owner` is your own GitHub username,
   and previews the DNS diff.
5. When it merges, the zone is pushed to Cloudflare within a minute or two.

### The file

```json
{
  "domain": "is-a.ceo",
  "subdomain": "mc",
  "owner": "your-github-username",
  "email": "you@example.com",
  "repo": "github.com/you/your-repo",
  "description": "My Minecraft server",
  "records": {
    "A": ["203.0.113.10"],
    "SRV": [
      { "priority": 0, "weight": 5, "port": 25565, "target": "mc.is-a.ceo" }
    ]
  }
}
```

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
must match exactly. All of these are valid, following the reference registry:

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
unclaimed name in the zone. The filename contains
`*`, which Windows cannot create on an NTFS disk. That matches the reference
registry, where everything runs on Linux and CI. If you develop on Windows,
add wildcard entries through the GitHub web interface instead of a local
clone.

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
  "A":    ["203.0.113.10", "203.0.113.11"],
  "AAAA": ["2001:db8::10"],
  "CNAME": ["example.github.io"],
  "TXT":  ["v=spf1 include:_spf.google.com -all"],
  "MX":   [{ "priority": 10, "target": "mx.example.com" }],
  "NS":   ["ns1.example.com", "ns2.example.com"],
  "SRV":  [{ "priority": 0, "weight": 5, "port": 25565, "target": "mc.is-a.ceo" }],
  "CAA":  [{ "flag": 0, "tag": "issue", "value": "letsencrypt.org" }]
}
```

An apex (`@`) entry cannot use `CNAME`; use `A`/`AAAA` there.

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
