# freepi-proxy

A zero-dependency OpenAI-compatible proxy for [free-pi-cli](https://github.com/dennisonbertram/free-pi-cli).  
It lets **opencode** (or any OpenAI-API harness) use free-pi as its LLM provider, while:

- **keeping ads** — the proxy polls the free-pi ads endpoint every 30 s and displays them in its own terminal window, maintaining the ethical ad-supported model
- **reusing your existing credentials** — reads `~/.free-pi/agent/credentials.json`, no duplicate login
- **not touching pi's TUI** — you can keep a separate `free-pi-cli` window for its slash-commands if you want
- **tracking your remaining quota** — live credits per day via `GET /me`, persisted to disk
- **rotating between accounts** — continues on another account shortly *before* the daily budget runs out, and reuses accounts whose budget has been refilled

---

## Quick start (Windows)

```powershell
git clone https://github.com/369adi/freepi-proxy
cd freepi-proxy
```

Then **double-click `Setup.cmd`** — it checks Node.js, seeds the account store,
writes the opencode and DeepSeek Harness configs and runs a health check.

Afterwards **double-click `Start-Proxy.cmd`**. Leave that window open; ads print
there. Stop it with `Stop-Proxy.cmd` or `Ctrl+C`.

That's it — opencode and DSH can now talk to `http://127.0.0.1:4000/v1`.

---

## Prerequisites

1. **Node.js ≥ 18** — <https://nodejs.org> (LTS). No `npm install` needed,
   the project has zero dependencies.
2. **A free-pi login.** Run once:

   ```powershell
   npx free-pi-cli
   ```

   Go through the consent screen and log in with GitHub. This creates
   `%USERPROFILE%\.free-pi\agent\credentials.json`.
   You do **not** need to keep the pi TUI open afterwards.

`Setup.cmd` tells you if either is missing.

---

## Setup commands

```powershell
node tools\setup.mjs            # same as Setup.cmd, step by step
node tools\setup.mjs --check     # read-only: what is installed and configured
node tools\setup.mjs --force     # re-apply configs without asking
```

`setup` is idempotent — running it twice changes nothing twice.

---

## Start / stop

```powershell
node proxy.mjs                   # foreground, see the ads
```

| Windows | |
|---|---|
| `Setup.cmd` | install / configure |
| `Start-Proxy.cmd` | start the proxy, checks prerequisites first |
| `Stop-Proxy.cmd` | kill a running proxy |
| `Watchdog.cmd` | supervise the proxy — restarts it if it dies |

### Keep it running

If the proxy stops, every client that points at `127.0.0.1:4000` fails with a
connection error. The watchdog prevents that:

```powershell
node tools\watchdog.mjs              # supervise in this console
node tools\watchdog.mjs --install    # start automatically at logon
node tools\watchdog.mjs --remove     # undo
```

Logs, which are the first place to look after a crash:

| File | Content |
|---|---|
| `%USERPROFILE%\.free-pi\proxy\proxy.log` | proxy stdout/stderr |
| `%USERPROFILE%\.free-pi\proxy\crashes.log` | start/exit events with timestamps |

The watchdog polls `/v1/models` every 20 s and restarts the proxy after three
failed checks in a row.

Custom port:

```powershell
$env:FREEPI_PROXY_PORT = 5000
node proxy.mjs
```

---

## Connect opencode

`Setup.cmd` writes this for you. Manually, add to `opencode.json`
(project) or `~/.config/opencode/config.json` (global):

```json
{
  "provider": {
    "freepi": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "free-pi (local proxy)",
      "options": {
        "baseURL": "http://127.0.0.1:4000/v1",
        "apiKey": "freepi-proxy"
      }
    }
  }
}
```

Then `opencode` calls your proxy, which forwards to free-pi.

---

## Connect DeepSeek Harness

`Setup.cmd` appends a `freepi` provider to the profile patch under
`%USERPROFILE%\.dsh\profiles\<profile>\*.yml`:

```yaml
freepi:
  type: openai-completions
  baseUrl: http://127.0.0.1:4000/v1
  apiKeyEnv: FREEPI_PROXY_API_KEY
  default: deepseek-v4.1-flash
```

Set the key (any non-empty string — the proxy does not check it):

```powershell
setx FREEPI_PROXY_API_KEY freepi-proxy
```

---

## Troubleshooting

Run the doctor:

```powershell
node tools\doctor.mjs
```

It checks Node, credentials, the account store, token validity (live),
whether the client version is still accepted, the port and reachability of
`api.freepi.ai`.

| Symptom | Fix |
|---|---|
| `Node.js not found` | install Node ≥ 18, reopen the terminal |
| `No usable free-pi account` | run `npx free-pi-cli` once, then `node tools\freepi-accounts.mjs import` |
| `Port 4000 in use` | `$env:FREEPI_PROXY_PORT = 5000`, or `Stop-Proxy.cmd` for a stale instance |
| `free-pi requires a newer version` | raise `FREEPI_VERSION` in `proxy.mjs` |
| `token rejected (401)` | `node tools\freepi-accounts.mjs add` to log in again |
| requests fail with 402/429 | budget used up everywhere — see the rotation section |

---

## Endpoints exposed

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | Returns the model catalog from free-pi |
| `POST` | `/v1/chat/completions` | Proxies to `api.freepi.ai` with the active account |
| `GET` | `/usage` | Local JSON: remaining credits per account + what the rotator does next |
| `GET` | `/accounts` | Same payload as `/usage` |

All other paths return 404.

---

## Usage tracking and account rotation

free-pi grants a daily credit allowance per account (`allowance_credits`, currently
15 000) that refills at `refill_at`. The proxy keeps a persistent account store at

```
%USERPROFILE%\.free-pi\proxy\accounts.json      (override: FREEPI_ACCOUNTS_PATH)
```

> **This file contains login tokens.** It lives outside the repository on purpose —
> never commit it, never paste it anywhere.

For every account the store remembers:

- `usage` — last measurement from `GET /me`: `allowanceCredits`,
  `remainingCreditsToday`, the USD cap (`cap_usd_today` / `remaining_usd_today`),
  `refillAt`, tier and the time of measurement
- `day` — how many credits were consumed today
- `history` — the last 60 days of consumption, rolled over automatically at refill
- totals — credits used overall and per day across all accounts

### When does it switch?

Every account is classified on each check:

| State | Meaning |
|-------|---------|
| `ready` | enough budget — keep using it |
| `low` | below the watermark (default 10 % of the allowance) — switch when a better account exists |
| `exhausted` | nothing left today |
| `refillable` | was empty, but `refill_at` has passed — re-measure, then reuse |
| `stale` | last measurement older than 10 min — re-measure |
| `invalid` | token rejected or expired — needs a new login, never used automatically |

The decision order (`tools/lib/policy.mjs`, pure functions, unit-tested):

1. active account is `ready` → keep it
2. another existing account has more budget → **switch to it** (this is the
   "switch shortly before it is used up" step — a `low` account is only kept when
   it is the best one left)
3. some data is out of date → re-measure, then decide again
4. everything empty, but a daily refill is within 20 min → **wait**, requests
   fail until then instead of burning a fresh account
5. only then: a new account is genuinely required

### Managing accounts

```powershell
node tools\freepi-accounts.mjs status      # per-account state, budget, refill time
node tools\freepi-accounts.mjs plan        # what the rotator would do right now
node tools\freepi-accounts.mjs refresh     # re-measure every account via /me
node tools\freepi-accounts.mjs add         # log in another account (device flow)
node tools\freepi-accounts.mjs use acc-2   # pin an account as active
node tools\freepi-accounts.mjs remove acc-2
node tools\freepi-accounts.mjs import      # seed from free-pi-cli credentials.json
```

`npm test` runs the rotation-policy unit tests (`node --test`).

### Running out of budget

Adding an account is **not** automated: it needs a GitHub sign-up, which is a
human step by design. When `plan` reports `create a NEW account gh-N@arisya.de`:

1. create a GitHub account using that address (a catch-all domain delivers the
   verification mail to the catch-all mailbox)
2. read the verification link:
   `node tools\fetch-verify-mail.mjs gh-N@arisya.de`
   (configured through `IMAP_USER`, `IMAP_PASS`, `IMAP_HOST`, `IMAP_PORT`)
3. `node tools\freepi-accounts.mjs add` — prints a code for
   `github.com/login/device`, handles the consent step, stores the token

The proxy itself never creates accounts; it only tells you when one is needed
and keeps serving from existing accounts otherwise.

---

## No model remapping

The proxy forwards the model ID **verbatim, 1:1** to free-pi — it never
rewrites the model name.  Configure opencode to request a free-pi model
directly, for example:

```json
{ "model": "deepseek/deepseek-v4-flash" }
```

---

## Keeping up with free-pi-cli releases

The proxy sends `x-client-version: 0.6.15` to the server.  If free-pi blocks
an old version, it will print:

```
✗  free-pi requires a newer version of the CLI
```

Open `proxy.mjs` and update the `FREEPI_VERSION` constant to the latest
`free-pi-cli` version from npm.

---

## About the ads

free-pi offers free inference because ads pay for it.  This proxy calls
`/ads/next` every 30 seconds and prints the ad content to its terminal.
Do **not** suppress or skip this — it's what makes the free tier sustainable.
