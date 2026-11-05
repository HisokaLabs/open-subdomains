# open-subdomains

[![Registry check](https://github.com/HisokaLabs/open-subdomains/actions/workflows/check.yml/badge.svg)](https://github.com/HisokaLabs/open-subdomains/actions/workflows/check.yml)
[![Zone status](https://github.com/HisokaLabs/is-a.ceo/actions/workflows/health.yml/badge.svg)](https://github.com/HisokaLabs/is-a.ceo/actions/workflows/health.yml)
[![Site build](https://github.com/HisokaLabs/is-a.ceo/actions/workflows/pages.yml/badge.svg)](https://github.com/HisokaLabs/is-a.ceo/actions/workflows/pages.yml)

Free subdomains for a portfolio, an API, or the Minecraft server you keep restarting. Your name, but as a CEO.

The DNS registry behind [is-a.ceo](https://is-a.ceo). Every claimed subdomain is one JSON file. Merge the pull request and the record is live in a couple of minutes. No dashboard, no account, and the PR stays as your own receipt.

Available zones:

- `is-a.ceo`

More get added as the registry grows. The site at [is-a.ceo](https://is-a.ceo) is a separate repository, [HisokaLabs/is-a.ceo](https://github.com/HisokaLabs/is-a.ceo), and renders everything from the files in `domains/`.

## How it works

```
domains/*.json -> dnsconfig.js -> dnscontrol push -> Cloudflare
```

`domains/` is the only place anyone edits. `dnsconfig.js` reads those files when DNSControl runs; nothing is generated ahead of time. Merge on `main` and CI pushes the zone.

Leave `records` out entirely and the name points at GitHub Pages by default, so `your-name.is-a.ceo` serves `your-name.github.io` the moment your pull request merges. That is the whole setup for most people.

## Claiming one

See [CONTRIBUTING.md](CONTRIBUTING.md) for the walkthrough, the record types, and the rules.

Two minutes: copy one JSON file, fill in your name, open a PR. Check the name first at [is-a.ceo/check](https://is-a.ceo/check) if you are unsure it is free.

## Repository guide

This part is for maintainers and anyone curious about the plumbing. Claiming a subdomain only involves `domains/`.

### How a change flows through

```
pull request -> check.yml (validate, test, verify owner, dnscontrol check)
             -> merge to main -> push.yml (dnscontrol push) -> Cloudflare
```

The zones this registry is allowed to touch are listed in `domains/_meta.json` under `zones`. The validator rejects any entry naming a zone outside that list, so a typo can never reach the `dnscontrol push` stage and break the other zones' deployment.

### Layout

| Path | What it is |
| --- | --- |
| `domains/*.json` | One file per record, named `<subdomain>.<zone>.json`. The registry. |
| `domains/_meta.json` | Zones, maintainers, reserved and blocked names, length limits. |
| `domains/_example.json` | Copy-paste template for a new entry. |
| `domains/SCHEMA.json` | JSON Schema for an entry. Editor autocomplete. |
| `dnsconfig.js` | Loads `domains/*.json` at runtime and declares one zone per entry. |
| `scripts/validate.js` | The strict validator. Fails CI on any rule violation. |
| `scripts/verify-owners.js` | PR-author check. Owner must match the claimant. |
| `scripts/health-check.js` | Probes every zone's SOA and reports the dead ones. |
| `test/validate.test.js` | Node test suite covering every validator rule. `npm test`. |
| `.github/pull_request_template.md` | The form every pull request fills in. |
| `.github/workflows/` | check, push, health, stale, label. |

The registry ships with two infrastructure entries, `@.is-a.ceo.json` (zone apex, the website's GitHub Pages records) and `www.is-a.ceo.json`. Apex records are ordinary entries here, not a separate config file.

### Run the tests

```bash
npm run check   # validate the real registry in domains/
npm test        # the validator test suite, 28 cases, no dependencies
```

The suite builds each fixture in a temporary directory, runs `scripts/validate.js` against it, and asserts the exit code, so the real registry is never touched. Every rule in `CONTRIBUTING.md` has a case: private and reserved addresses, IPv4-mapped IPv6, CNAME exclusivity, duplicate values, reserved labels, the one-name-per-owner quota, wildcard and underscore base ownership, and the owner-matches-PR-author check. Two wildcard cases are skipped on Windows because the operating system forbids `*` in a filename; they run on CI.
### Adding a zone

1. Add the zone to the same Cloudflare account and make sure the `CLOUDFLARE_API_TOKEN` secret can edit its DNS.
2. Add the zone name to `zones` in `domains/_meta.json`. If you are not the PR author, add yourself to `maintainers` too, since that list also gates zone-wide `*` wildcards.
3. Commit its infrastructure entries: `@.<zone>.json` for the apex, plus anything else the zone needs such as `www.<zone>.json`.
4. Optional: give the zone copy in `site/config.json` under `zones` in the site repository. Unknown zones fall back to the default branding, so this step only changes wording.

Every zone in the data is declared automatically. The validator refuses entries for zones that are not in the list, which keeps typos out before anything merges.

### Credentials

`creds.json` is committed and contains only an indirection:

```json
{
  "cloudflare": {
    "TYPE": "CLOUDFLAREAPI",
    "apitoken": "$CLOUDFLARE_API_TOKEN"
  }
}
```

DNSControl expands `$CLOUDFLARE_API_TOKEN` from the environment, so no secret ever lands in this repository. GitHub Actions injects the real token as a repository secret, scoped to `Zone.DNS` edit on every zone this registry manages.

### GitHub Actions

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `check.yml` | PR, push main | Validates `domains/`, verifies owners, runs `dnscontrol check`. |
| `push.yml` | push main | Runs `dnscontrol push` against Cloudflare. |
| `health.yml` | every 30 min | Probes every zone's SOA; opens an issue when a zone is down. |
| `stale.yml` | daily | Marks idle PRs stale and closes them a week later. |
| `label.yml` | PR | Labels PRs by changed files (domain, scripts, docs, ci). |

## Deployment

Records are managed with [DNSControl](https://github.com/StackExchange/dnscontrol) and pushed by [HisokaLabs/dnscontrol-actions@v4](https://github.com/HisokaLabs/dnscontrol-actions).

## Abuse

Report abuse to [abuse@hisoka.net](mailto:abuse@hisoka.net), or read the policy at [is-a.ceo/abuse](https://is-a.ceo/abuse).

## License

[ISC](LICENSE), same as the site.
