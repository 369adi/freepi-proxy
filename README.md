# freepi-proxy

A zero-dependency OpenAI-compatible proxy for [free-pi-cli](https://github.com/dennisonbertram/free-pi-cli).  
It lets **opencode** (or any OpenAI-API harness) use free-pi as its LLM provider, while:

- **keeping ads** — the proxy polls the free-pi ads endpoint every 30 s and displays them in its own terminal window, maintaining the ethical ad-supported model
- **reusing your existing credentials** — reads `~/.free-pi/agent/credentials.json`, no duplicate login
- **not touching pi's TUI** — you can keep a separate `free-pi-cli` window for its slash-commands if you want
- **tracking your remaining quota** — live credits per day via `GET /me`, persisted to disk
- **rotating between accounts** — continues on another account shortly *before* the daily budget runs out, and reuses accounts whose budget has been refilled

---

## Prerequisites

1. Run `npx free-pi-cli` **once** to go through the consent screen and log in with GitHub.  
   This creates `~/.free-pi/agent/credentials.json`.  
   You do not need to keep the pi TUI open after that.

2. Node.js ≥ 18 (no npm install needed — zero dependencies).

---

## Start the proxy

```powershell
cd C:\Users\liket\Documents\freepi-proxy
node proxy.mjs
```

Or with a custom port:

```powershell
$env:FREEPI_PROXY_PORT = 5000
node proxy.mjs
```

Leave this window **open** while you work — ads print here.

> On Windows you can also double-click `Start-Proxy.cmd`.

---

## Connect opencode

opencode reads its provider config from `opencode.json` (project-level) or
`~/.config/opencode/config.json` (global).  Add or merge:

```json
{
  "provider": "openai",
  "openai": {
    "baseUrl": "http://127.0.0.1:4000/v1",
    "apiKey": "freepi-proxy"
  }
}
```

Then in your project just run `opencode` as normal — it will call your proxy
which forwards to free-pi.

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
