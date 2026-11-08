# open-subdomains

[![Registry check](https://github.com/HisokaLabs/open-subdomains/actions/workflows/check.yml/badge.svg)](https://github.com/HisokaLabs/open-subdomains/actions/workflows/check.yml)
[![Zone status](https://github.com/HisokaLabs/open-subdomains/actions/workflows/health.yml/badge.svg)](https://github.com/HisokaLabs/open-subdomains/actions/workflows/health.yml)

Free subdomains under `is-a.ceo`, for a portfolio, an API, or the Minecraft server you keep restarting.

This repository is the DNS registry behind [is-a.ceo](https://is-a.ceo). Every claimed name is one JSON file in `domains/`. Merge the pull request and the record is live in a couple of minutes. No dashboard and no account: the pull request stays as the record of who asked for the name and when it went live.

[Documentation](https://docs.is-a.ceo) &middot; [Terms of Service](https://is-a.ceo/terms) &middot; [Name checker](https://is-a.ceo/check) &middot; [Abuse policy](https://is-a.ceo/abuse)

## Register a subdomain

1. Check the name at [is-a.ceo/check](https://is-a.ceo/check). It reads the same policy the validator applies, so its verdict matches CI.
2. Fork this repository and copy `domains/_example.json` to `domains/<your-subdomain>.is-a.ceo.json`.
3. Fill in the file. `owner` has to be your own GitHub username, and you have to be the one opening the pull request. Leave `owner` or `email` detailed enough that a maintainer can reach you.
4. Run `npm run verify`. That is the same command CI runs.
5. Open the pull request against `main` and fill in the template. Watch it afterwards in case a maintainer asks for changes.

These names are for personal and non-commercial sites. No shops, no business sites, no advertising, and no holding a name to sell it later. The site behind the name has to be reachable and finished when you open the pull request; a placeholder is refused.

Leave `records` out of the file and the name points at GitHub Pages by default, so `your-name.is-a.ceo` serves `your-name.github.io` the moment the pull request merges.

The registry accepts one claim per pull request, in one file. `domains/` is the only directory a claimant edits.

The full walkthrough, the field list and the record types are in the documentation. Start with [Claim a subdomain](https://docs.is-a.ceo/claim/), then keep [Troubleshooting](https://docs.is-a.ceo/troubleshooting/) open while CI runs.

## Report abuse

If a subdomain breaks the [Terms of Service](https://is-a.ceo/terms), report it to [abuse@hisoka.net](mailto:abuse@hisoka.net). The policy and what happens after a report is published at [is-a.ceo/abuse](https://is-a.ceo/abuse).

## For maintainers

DNS records are managed with [DNSControl](https://github.com/StackExchange/dnscontrol) and pushed by [HisokaLabs/dnscontrol-actions@v4](https://github.com/HisokaLabs/dnscontrol-actions). `dnsconfig.js` reads `domains/*.json` at runtime, so nothing is generated ahead of time.

```bash
npm run verify        # check, check:format and the full suite, as CI runs them
npm test              # the suite alone, 129 cases, no dependencies
```

The repository guide that used to live here is now in the documentation: [Workflows](https://docs.is-a.ceo/workflows/), [Watchers and scripts](https://docs.is-a.ceo/operations/), [DNS pipeline](https://docs.is-a.ceo/dns-pipeline/), and [Adding a zone](https://docs.is-a.ceo/zones/).

## License

[ISC](LICENSE), same as the site.
