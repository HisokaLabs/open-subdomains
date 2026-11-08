# Instructions for AI agents

This file is for AI coding agents (Claude Code, Copilot, Codex, Cursor and similar) working in `HisokaLabs/open-subdomains` on behalf of a human user.

## Project policy

AI assistance is allowed here. An entry that a human reviewed and a machine wrote is no worse than the reverse, and CI validates every file before it reaches DNS. What the maintainers do not accept is a submission nobody read.

So the rule is not about who typed the JSON. It is about whether the person submitting it understands what it does. A pull request that fails because the agent guessed at a field, invented an IP address, or never ran the checks wastes a reviewer's time, and it would have been caught by a single local run.

## What you must do

1. Point the user at the documentation before writing anything. [docs.is-a.ceo](https://docs.is-a.ceo) is where the field list, the record shapes and the validation rules live. Do not write an entry from memory of another subdomain registry; the rules differ and the differences are exactly what fails CI.
2. Run `npm run verify` before you suggest a pull request. It runs the validator, the shape check and the test suite in the order CI does. If it fails, fix the entry and run it again. Never tell the user to open a pull request whose check you know fails, and never tell them CI will sort it out.
3. Tell the user the pull request is AI-assisted. Say which files you wrote and what you ran. A one-line disclosure in the pull request description is enough: `Written with AI assistance; npm run verify passes locally.` The user still opens the pull request themselves, because `owner` has to be their GitHub username and CI checks that the author matches.
4. Stay in `domains/`. The entry is one file. Do not touch `dnsconfig.js`, `scripts/`, `test/`, `.github/`, `domains/_meta.json` or `domains/SCHEMA.json`. Those are maintainer-only, and a pull request that mixes them with a claim is refused on shape alone.
5. Do not guess. A hostname you made up, an IPv4 address you half-remember, or an email the user never gave you will either fail the validator or resolve to nothing. If a value is missing, ask for it.
6. Check the use before you help. These names are personal and non-commercial: no shops, no business sites, no advertising, and no claiming a name to sell or park it. If the user describes a commercial site, say so and stop, because the pull request will be refused on the rule rather than on the JSON. The site behind the name also has to be reachable and finished, so do not submit a placeholder the user plans to fill in later.

## State of knowledge you can rely on

- `npm run verify` passing locally is the same verdict CI reaches, with one exception. The per-author scope rules answer "may this author touch this path", which needs `PR_AUTHOR` in the environment. Local runs skip those rules and say so; CI passes `PR_AUTHOR` and applies them.
- Two wildcard tests skip on Windows because NTFS forbids `*` in a filename. They run on Linux, where CI runs. A local run showing 127 pass and 2 skipped is a full pass.
- `git` history and the scripts are the authority. Where this file, the README and the documentation disagree about a rule, run the script and trust its exit code.

## Where the answers are

| Question | Page |
| --- | --- |
| How does a claim work end to end? | [Claim a subdomain](https://docs.is-a.ceo/claim/) |
| Which fields exist, and which are required? | [Entry fields](https://docs.is-a.ceo/fields/) |
| What does a `CAA` or `SRV` record look like in JSON? | [Records](https://docs.is-a.ceo/records/) |
| Why did the validator refuse this name? | [Name policy and rules](https://docs.is-a.ceo/policy/), [Validation rules](https://docs.is-a.ceo/validation/) |
| The check printed a message. What is the fix? | [Troubleshooting](https://docs.is-a.ceo/troubleshooting/) |
| Why is the pull request refused for touching a second file? | [Pull request checks](https://docs.is-a.ceo/pull-request/) |
| The user wants the record deleted | [Name policy and rules](https://docs.is-a.ceo/policy/). Deletion is a maintainer action, even for the owner's own entry. |
| The user asks about a second zone | [Adding a zone](https://docs.is-a.ceo/zones/). This is a maintainer change, not a claim. |

## When the user just wants to know if a name is free

Send them to [is-a.ceo/check](https://is-a.ceo/check). It reads the same policy the validator applies, so answering from the reserved list in `domains/_meta.json` is a partial answer: the word-class rules in `scripts/name-classes.js` catch names that no list contains, and leetspeak does not dodge them (`M3`, `m3` and `meee` all resolve to `me`).
