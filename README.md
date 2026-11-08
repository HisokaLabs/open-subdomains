# open-subdomains

[![Registry check](https://github.com/HisokaLabs/open-subdomains/actions/workflows/check.yml/badge.svg)](https://github.com/HisokaLabs/open-subdomains/actions/workflows/check.yml)
[![Zone status](https://github.com/HisokaLabs/open-subdomains/actions/workflows/health.yml/badge.svg)](https://github.com/HisokaLabs/open-subdomains/actions/workflows/health.yml)

Free subdomains under `is-a.ceo`, for a portfolio, an API, or the Minecraft server you keep restarting.

Every claimed name is one JSON file in `domains/`. The filename is the name. Merge the pull request and the record is live in a couple of minutes.

[Documentation](https://docs.is-a.ceo) &middot; [Check a name](https://is-a.ceo/check) &middot; [Registered subdomains](https://is-a.ceo/#domains)

## Claim one

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

That is the whole file. No `domain`, no `subdomain`, no `records`: the filename says `jane` in `is-a.ceo`, and leaving `records` out points the name at GitHub Pages, so it serves `jane.github.io` as soon as the merge lands.

1. Check the name at [is-a.ceo/check](https://is-a.ceo/check). It reads the same policy the validator applies.
2. Fork this repository and copy `registry/example.json` to `domains/<your-name>.is-a.ceo.json`.
3. Fill in `owner` with at least one of `username`, `id` or `email`. `id` is the number at `https://api.github.com/users/<your-name>`, and it is what keeps the claim yours after a rename. An entry with only an `email` cannot be matched to your account, so add `username` or `id` when you are claiming it yourself.
4. Open the pull request from the account named in `owner`. A claim belongs to whoever opens it.
5. Run `npm run verify` if you want the same verdict CI will give you.

## What lives where

| Path | Holds |
| --- | --- |
| `domains/` | One JSON file per claim, and nothing else |
| `registry/zones.json` | The zones this repository serves |
| `registry/reserved.json` | Names the registry already points somewhere |
| `registry/blocked.json` | Names refused under every zone |
| `registry/trusted.json` | Who may edit code, policy, and other people's entries |
| `registry/schema.json` | The shape of one entry, for editor autocomplete |

Policy is not mixed into `domains/`, so every file there is a claim by definition.

## The rules worth knowing before you start

These names are personal and non-commercial. No shops, no business sites, no advertising, and no holding a name to sell it later. The site behind the name has to be reachable and finished when you open the pull request; a placeholder is refused.

Two lists decide what is claimable, and they are not the same thing.

`registry/reserved.json` holds names the registry operates itself, so their records live in the Cloudflare dashboard rather than in `domains/`. They are not free, and asking does not change that. `dnsconfig.js` keeps them out of purge on every push, which is why `www` and `docs` survive without an entry file.

`registry/blocked.json` holds brands and impersonation targets. Those are refused for everyone, trusted authors included.

## For maintainers

DNS records are managed with [DNSControl](https://github.com/StackExchange/dnscontrol) and pushed by [HisokaLabs/dnscontrol-actions@v4](https://github.com/HisokaLabs/dnscontrol-actions). `dnsconfig.js` reads `domains/*.json` and `registry/zones.json` at run time, so nothing is generated ahead of time.

```bash
npm run verify     # the validator and the test suite, as CI runs them
npm test           # the suite alone
npm run status     # what every entry actually serves
npm run zones      # does every zone answer with an SOA
npm run proof      # write or remove a Vercel ownership sidecar
```

`npm run check` is the validator on its own. Add `--json` for `{ ok, verified, problems, warnings }`.

The whole pipeline is described at [docs.is-a.ceo](https://docs.is-a.ceo).

## License

[ISC](LICENSE), same as the site.
