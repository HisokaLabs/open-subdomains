# Contributing

This is the short version. The full documentation is at [docs.is-a.ceo](https://docs.is-a.ceo), and it is the place to look when a check fails or a field is not obvious.

## Claim a subdomain

1. Check the name at [is-a.ceo/check](https://is-a.ceo/check). It applies the same policy as the validator, so a name it refuses is refused by CI too.
2. Fork this repository and create a branch.
3. Copy `domains/_example.json` to `domains/<your-subdomain>.is-a.ceo.json`. A claim for `jane` becomes `domains/jane.is-a.ceo.json`, and the filename has to match the `subdomain` and `domain` inside the file.
4. Run `npm run verify`. It runs the validator, the shape check and the test suite in the order CI does.
5. Open the pull request against `main` and fill in the template.

After the merge, `push.yml` runs `DNSControl push` and the record answers within a minute or two, plus whatever your resolver caches.

The end-to-end walkthrough is [Claim a subdomain](https://docs.is-a.ceo/claim/).

## The file

```json
{
  "$schema": "./SCHEMA.json",
  "domain": "is-a.ceo",
  "subdomain": "jane",
  "owner": "jane",
  "email": "jane@example.com",
  "repo": "github.com/jane/jane.github.io",
  "description": "My Minecraft server"
}
```

`domain`, `subdomain` and `owner` are required. Omitting `records` entirely gives the GitHub Pages default: `jane.is-a.ceo` serves `jane.github.io` with nothing else to configure.

Every field is listed in [Entry fields](https://docs.is-a.ceo/fields/), and each record type with its JSON shape is in [Records](https://docs.is-a.ceo/records/). `A`, `AAAA`, `CNAME`, `TXT`, `MX`, `NS`, `SRV`, `CAA` and `PTR` are supported. All of them take an array except `CNAME`, which takes one target as a bare string.

The machine-readable definition is [domains/SCHEMA.json](domains/SCHEMA.json), published as <https://is-a.ceo/domains.schema.json>. Add `"$schema": "./SCHEMA.json"` to the top of your file and your editor will autocomplete the fields.

## What the pull request may contain

One claim, one file:

- Only files in `domains/`, plus documentation.
- At most four files under `domains/`. The real maximum is a claim plus its Vercel proof, described under [Pointing at Vercel](https://docs.is-a.ceo/records/#pointing-at-vercel).
- Two-space indent and a final newline.

`dnsconfig.js`, `scripts/`, `test/`, `.github/`, `domains/_meta.json` and `domains/SCHEMA.json` are maintainer-only. Those files decide what everyone else may claim, so a change to them is reviewed on its own.

Editing the records in your own entry is fine. Deleting an entry is a maintainer action even when the entry is yours, because a delete and a claim are not the same review.

## Rules

- `owner` is your own GitHub username, and you are the one opening the pull request. CI compares the two.
- Give a maintainer a way to reach you. `owner` or `email` has to be enough to get in touch, because that is who a maintainer contacts when a name is reported or breaks.
- Personal and non-commercial use only. No shop, no business site, no advertising, and no holding a name to sell it later.
- The site has to be reachable and finished. A parked page, a placeholder or an empty repository is refused.
- There is no limit on how many names one person holds. Claim as many as you need, each in its own file.
- A wildcard such as `*.go` is only accepted when you already claim `go` in the same zone. The same applies to underscore records like `_acme-challenge.go`.
- Records have to point at the public internet. Private, loopback and documentation addresses are rejected.
- Nothing that would get the zone delisted: no malware, no phishing. Keep it legal in the Netherlands, where the zone is hosted.
- Do not touch another person's file without asking them first.

The complete list, including which names are reserved, blocked, or refused by word class, is in [Name policy and rules](https://docs.is-a.ceo/policy/).

## When a check fails

`npm run verify` prints the message CI would print, prefixed with the file that caused it. [Troubleshooting](https://docs.is-a.ceo/troubleshooting/) has a row for each one with the fix. If the message is not there, [Validation rules](https://docs.is-a.ceo/validation/) explains the rule behind it.

The pull request bot comments the same verdict as a line per problem, so you do not need a local clone to read it.

## Redirects

The zone is DNS only. There is no redirect record and no way to rewrite a path, so host the redirect yourself: add an HTML meta refresh behind a `CNAME`, or use the redirect feature your host offers.

## Abuse

Report abuse to [abuse@hisoka.net](mailto:abuse@hisoka.net). The policy and what happens after a report is at [is-a.ceo/abuse](https://is-a.ceo/abuse).
