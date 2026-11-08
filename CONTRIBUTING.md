# Contributing

One claim is one file. Check the name, copy the template, open the pull request.

## Claim a subdomain

1. Check the name at [is-a.ceo/check](https://is-a.ceo/check). It applies the same policy as the validator, so a name it refuses is refused by CI too.
2. Fork this repository and create a branch.
3. Copy `registry/example.json` to `domains/<your-name>.is-a.ceo.json`. A claim for `jane` becomes `domains/jane.is-a.ceo.json`.
4. Run `npm run verify`. It runs the validator and the test suite in the order CI does.
5. Open the pull request against `main` and fill in the template.

## An example pull request

Title: `Claim jane.is-a.ceo`

Changed files: `domains/jane.is-a.ceo.json`, added.

```json title="domains/jane.is-a.ceo.json"
{
  "$schema": "../registry/schema.json",
  "owner": {
    "username": "jane",
    "id": 1234567
  },
  "repo": "github.com/jane/jane.github.io",
  "description": "Portfolio"
}
```

Body: tick the five boxes, then fill in the two marked sections.

```text
Website preview: https://jane.github.io
Purpose: Portfolio
```

That is the whole change. A claim that also needs `records`, or a `_vercel` sidecar for a Vercel domain, adds those files and stays one pull request.

## The file

`owner` is the only required key, and inside it you need at least one of `username`, `id` or `email`.

The `id` is the number at `https://api.github.com/users/<username>`. A username can be released and taken by someone else, while the number cannot, so include it and the claim survives your next rename. CI compares it against the account that opens the pull request, which is why a claim cannot be filed on someone else's behalf.

An entry with only an `email` has nothing to compare against an account, so only a trusted author can file one. Include `username` or `id` if you are claiming a name yourself.

Omitting `records` points the name at GitHub Pages, which is what most portfolios need. Any other host takes a `records` block: `A`, `AAAA`, `CNAME`, `TXT`, `MX`, `NS`, `SRV`, `CAA` and `PTR` are supported, all of them arrays except `CNAME`, which takes one target as a bare string. [Records](https://docs.is-a.ceo/records/) has the shape for each.

[registry/schema.json](registry/schema.json) is the machine-readable version. Pointing `$schema` at it gives you autocomplete and inline validation in any editor with a JSON Schema extension.

## What a pull request may contain

- Only files in `domains/`, plus a typo fix in the documentation.
- Two-space indent and a final newline.

`dnsconfig.js`, `scripts/`, `test/`, `.github/` and everything in `registry/` are trusted-author territory. Those files decide what everyone else may claim, so a change to them is reviewed on its own.

Editing the records in your own entry is fine. Deleting an entry is not: releasing a name is a trusted author's action even when the entry is yours, because a delete and a claim are not the same review.

## Rules

- `owner` is your own GitHub handle, and you are the one opening the pull request.
- A maintainer needs a way to reach you. That is who gets contacted when a name is reported or breaks.
- Personal and non-commercial use only. No shop, no business site, no advertising, and no holding a name to sell it later.
- The site has to be reachable and finished. A parked page, a placeholder or an empty repository is refused.
- Claim as many names as you need, each in its own file. There is no limit.
- A wildcard such as `*.go` needs `go` claimed in the same zone first. The same applies to underscore records like `_acme-challenge.go`.
- Records point at the public internet. Private, loopback and documentation addresses are rejected.
- Nothing that would get the zone delisted: no malware, no phishing. Keep it legal in the Netherlands, where the zone is hosted.
- Do not touch another person's file without asking them first.

The complete list, including which names are reserved or blocked, is in [Name policy and rules](https://docs.is-a.ceo/policy/).

## Redirects

The zone is DNS only. There is no redirect record and no way to rewrite a path, so host the redirect yourself: an HTML meta refresh behind a `CNAME`, or the redirect feature your host offers.

## When a check fails

`npm run verify` prints the message CI would print, prefixed with the file that caused it. [Troubleshooting](https://docs.is-a.ceo/troubleshooting/) has a row for each one with the fix, and [Validation rules](https://docs.is-a.ceo/validation/) explains the rule behind it. The pull request bot comments the same verdict, so you do not need a local clone to read it.

## Abuse

Email [contact@hisoka.net](mailto:contact@hisoka.net) with the subject `abuse: <hostname>`. The policy is at [is-a.ceo/abuse](https://is-a.ceo/abuse).
