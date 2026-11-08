<p align="center">
  <img width="720" alt="is-a.ceo, your name but as a CEO" src="https://is-a.ceo/og.png">
</p>

<p align="center">
   <img alt="Domains" src="https://img.shields.io/github/directory-file-count/HisokaLabs/open-subdomains/domains?color=5c46eb&label=domains&style=for-the-badge">
   <img alt="Open Pull Requests" src="https://img.shields.io/github/issues-raw/HisokaLabs/open-subdomains?color=5c46eb&label=issues&style=for-the-badge">
   <img alt="Open Issues" src="https://img.shields.io/github/issues-pr-raw/HisokaLabs/open-subdomains?color=5c46eb&label=pull%20requests&style=for-the-badge">
   <br>
</p>


<h1 align="center">is-a.ceo</h1>

<p align="center"><strong>is-a.ceo</strong> gives you a free subdomain for the portfolio, the API, or the Minecraft server you keep restarting.</p>

<p align="center"><a href="https://docs.is-a.ceo">Documentation</a> &bull; <a href="https://is-a.ceo/check">Check a name</a> &bull; <a href="https://is-a.ceo/status">Status</a> &bull; <a href="https://is-a.ceo/terms">Terms</a></p>

---

## Register

1. Check the name at [is-a.ceo/check](https://is-a.ceo/check). It reads the same list the validator does.
2. [Fork](https://github.com/HisokaLabs/open-subdomains/fork) the repository.
3. Copy `registry/example.json` to `domains/<your-name>.is-a.ceo.json`. The filename is the name, and nothing inside the file repeats it.
4. Fill in `owner`, and run `npm run verify`.
5. Open the pull request from the account named in `owner`.

Merge it and `push.yml` writes the record. It answers within a minute or two, plus whatever your resolver caches.

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

That is the whole file. No `domain`, no `subdomain`, no `records`: leaving `records` out points the name at GitHub Pages, which is what a portfolio or a project page needs. Any other host takes a `records` block, and [Records](https://docs.is-a.ceo/records/) has the shape for each type.

Keep it personal and non-commercial, and put a finished site behind it before you open the pull request. A parked page or a placeholder is refused. The rest is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Report abuse

Email [contact@hisoka.net](mailto:contact@hisoka.net) with the subject `abuse: <hostname>`, the full hostname, what you saw, and whatever evidence you have. Reports in English or Indonesian are both fine. What happens next is in the [abuse policy](https://is-a.ceo/abuse).

## How it works

One JSON file per claim in `domains/`, policy in `registry/`, and [DNSControl](https://github.com/StackExchange/dnscontrol) reads both at push time through [HisokaLabs/dnscontrol-actions](https://github.com/HisokaLabs/dnscontrol-actions). Nothing is generated ahead of time, so the file you see in the pull request is the record that gets pushed.

The pipeline, and why each piece is where it is, is at [docs.is-a.ceo](https://docs.is-a.ceo/dns-pipeline/).

## License

[ISC](LICENSE), same as the site.
