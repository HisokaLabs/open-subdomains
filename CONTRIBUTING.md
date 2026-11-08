# Contributing

This is the short version. The full documentation is at [docs.is-a.ceo](https://docs.is-a.ceo), which is where to look when a check fails or a field is not obvious.

## Claim a subdomain

1. Check the name at [is-a.ceo/check](https://is-a.ceo/check). It applies the same policy as the validator, so a name it refuses is refused by CI too.
2. Fork this repository and create a branch.
3. Copy `registry/example.json` to `domains/<your-name>.is-a.ceo.json`. A claim for `jane` becomes `domains/jane.is-a.ceo.json`. The filename is the name; nothing inside the file repeats it.
4. Run `npm run verify`, which runs the validator and the test suite in the order CI does.
5. Open the pull request against `main` and fill in the template.

After the merge, `push.yml` runs `DNSControl push` and the record answers within a minute or two, plus whatever your resolver caches.

The end-to-end walkthrough is [Claim a subdomain](https://docs.is-a.ceo/claim/).

## The file

```json
{
  "$schema": "../registry/schema.json",
  "owner": {
    "username": "jane",
    "id": 1234567
  },
  "repo": "github.com/jane/jane.github.io",
  "description": "My Minecraft server"
}
```

`owner` is the only required key, and inside it you need at least one of `username`, `id` or `email`. None of the three is required on its own.

The `id` is the number at `https://api.github.com/users/<username>`. It matters because a username can be released and taken by someone else, while the number cannot. CI compares it against the account that opens the pull request, so a claim cannot be filed on someone else's behalf.

An entry with only an `email` has nothing to compare against an account, so it can only be filed by a trusted author. Include `username` or `id` if you are claiming a name yourself.

Omitting `records` gives the GitHub Pages default: `jane.is-a.ceo` serves `jane.github.io` with nothing else to configure.

Every field is listed in [Entry fields](https://docs.is-a.ceo/fields/), and each record type with its JSON shape is in [Records](https://docs.is-a.ceo/records/). `A`, `AAAA`, `CNAME`, `TXT`, `MX`, `NS`, `SRV`, `CAA` and `PTR` are supported. All of them take an array except `CNAME`, which takes one target as a bare string.

The machine-readable definition is [registry/schema.json](registry/schema.json), published as <https://is-a.ceo/entry.schema.json>. Pointing `$schema` at it gives you autocomplete in any editor with a JSON Schema extension.

## What the pull request may contain

One claim, one file:

- Only files in `domains/`, plus a typo fix in the documentation.
- Two-space indent and a final newline.

`dnsconfig.js`, `scripts/`, `test/`, `.github/` and everything in `registry/` are trusted-author territory. Those files decide what everyone else may claim, so a change to them is reviewed on its own.

Editing the records in your own entry is fine. Deleting an entry is not: releasing a name is a trusted author's action even when the entry is yours, because a delete and a claim are not the same review.

## Rules

- `owner` is your own GitHub handle, and you are the one opening the pull request. CI compares the two.
- Give a maintainer a way to reach you. `owner.username`, `owner.id` or `owner.email` has to identify someone who answers, because that is who a maintainer contacts when a name is reported or breaks.
- Personal and non-commercial use only. No shop, no business site, no advertising, and no holding a name to sell it later.
- The site has to be reachable and finished. A parked page, a placeholder or an empty repository is refused.
- There is no limit on how many names one person holds. Claim as many as you need, each in its own file.
- A wildcard such as `*.go` is only accepted when you already claim `go` in the same zone. The same applies to underscore records like `_acme-challenge.go`.
- Records have to point at the public internet. Private, loopback and documentation addresses are rejected.
- Nothing that would get the zone delisted: no malware, no phishing. Keep it legal in the Netherlands, where the zone is hosted.
- Do not touch another person's file without asking them first.

The complete list, including which names are reserved or blocked, is in [Name policy and rules](https://docs.is-a.ceo/policy/).

## When a check fails

`npm run verify` prints the message CI would print, prefixed with the file that caused it. [Troubleshooting](https://docs.is-a.ceo/troubleshooting/) has a row for each one with the fix. If the message is not there, [Validation rules](https://docs.is-a.ceo/validation/) explains the rule behind it.

The pull request bot comments the same verdict, one line per problem, so you do not need a local clone to read it.

## Redirects

The zone is DNS only. There is no redirect record and no way to rewrite a path, so host the redirect yourself: add an HTML meta refresh behind a `CNAME`, or use the redirect feature your host offers.

## Abuse

Report abuse to [abuse@hisoka.net](mailto:abuse@hisoka.net). The policy and what happens after a report is at [is-a.ceo/abuse](https://is-a.ceo/abuse).
