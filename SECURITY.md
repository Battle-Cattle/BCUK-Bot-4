# Security Policy

## Reporting a vulnerability

Please **don't open a public issue, pull request or discussion** for a security problem.

Report it privately through GitHub instead: on this repository's **Security** tab, choose **Report a vulnerability** (or go to <https://github.com/Battle-Cattle/BCUK-Bot-4/security/advisories/new>). Only the maintainers can see the report.

Include what you can of:

- what the problem is and what an attacker could do with it,
- the steps, request or input that reproduces it,
- the commit or page it affects.

We'll acknowledge the report, keep you updated while we fix it, and credit you in the advisory if you'd like.

## Supported versions

There are no releases. Only the current `main` branch, which is what's deployed, gets security fixes.

## How credentials are handled

- **OAuth tokens** (the Twitch bot account's and the EventSub broadcaster tokens) are stored encrypted with AES-256-GCM under `EVENTSUB_TOKEN_SECRET`. On rotation, the bot tries to re-encrypt them under the new key at each startup. A pass can leave some tokens under the previous key (a failed query, or a row that changed mid-pass), so keep the previous key until the bot logs that it can be removed (see the README's "Rotating EVENTSUB_TOKEN_SECRET").
- **API keys and one-time codes** (Stream Deck keys, companion app tokens and OAuth codes) are stored in the database only as SHA-256 hashes. The plaintext is shown when it's created. So that a double-submitted or refreshed request doesn't replace a new Stream Deck key or companion token, the bot keeps that plaintext in memory for up to 10 seconds and shows the same value to a repeat request in that window, then discards it.
- **Secrets** (bot tokens, client secrets, database credentials, the encryption key) are set in `.env`, which is never committed. The README asks operators to keep copies elsewhere too: a backup of `.env` off the server, and the previous `EVENTSUB_TOKEN_SECRET` after a rotation, for restoring older dumps. Those copies, and the database dumps (which hold the encrypted tokens), need the same care as `.env` itself (see the README's "Backups").
