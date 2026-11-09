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

### Slash commands inside DSH

`plugin/` holds a small DSH command plugin. `Setup.cmd` links it into
`%USERPROFILE%\.dsh\plugins\freepi-accounts`; `node tools\sync-plugin.mjs`
copies the repo version over it after an edit (`--check` reports drift only).
Restart DSH after syncing.

| Command | What it does |
|---|---|
| `/freepi-add` | Sign in another account. Opens GitHub with the code pre-filled in a **throw-away browser profile**, so the account already signed in is never disturbed. The profile is deleted afterwards. |
| `/freepi-add --reuse` | Same, but in the saved profile — use this to re-auth the account that is signed in there. |
| `/freepi-add --manual` | Print the code and wait for you to confirm the GitHub prompt by hand. |
| `/freepi-add --email you@example.com` | Record the address you actually registered instead of the suggested catch-all one. |
| `/freepi-status` | Budgets, refill times, rotation mode, proxy lanes. |
| `/freepi-usage` | Live load: lanes, in-flight requests, queue depth. |
| `/freepi-switch <id\|email>` | Pin one account for new requests. No argument lists the accounts. |
| `/freepi-auto` | Drop the pin so the proxy rotates by remaining budget again. |
| `/freepi-remove <id>` | Forget an account (clears the pin if it pointed there). |
| `/freepi-doctor` | Same checks as `tools\doctor.mjs`, inline: store, token lifetime, budget, pin, proxy reachability. |

No sign-out is needed between adds: each `/freepi-add` starts a fresh profile on
a free debug port, and only one add runs at a time (a lock file prevents two
GitHub device flows from colliding).

### Sponsor windows: one per account

free-pi is free because ads pay for it, and it gates that **per account**: until
account X has really displayed an ad, upstream answers
`403 {"code":"ads_required"}` for X. Showing an ad for account Y does nothing
for X. That is why a pooled setup needs one visible window per account — and
why an unhandled 403 shows up in a harness as "API key is invalid", since the
harness maps every 403 to an auth failure.

Open one window per account:

```
/freepi-ads            # every account
/freepi-ads acc-2      # just one
```

The same is available outside DSH:

```powershell
Show-Sponsor.cmd
```

Every window points at `http://127.0.0.1:4000/sponsor?account=<id>` and
`GET /sponsor/accounts` lists the exact URLs. Keep them visible.

What the proxy does when free-pi still asks for an ad:

- the account is **parked for ten minutes** and skipped by the request lanes,
  so following requests go to a working account instead of repeating the same
  403. `GET /accounts` shows `adsRequired: true` for such an account.
- that account's own window clears the block as soon as the card was really
  visible, so it rejoins the rotation immediately.
- an unknown account id never falls back to another account's window, and an
  impression can only be confirmed by the account that owns the nonce — one
  window can never acknowledge another account's ad.

Confirmation stays honest and unchanged: an impression is forwarded only after
the complete card was visible for at least one second, with the cookie and a
single-use nonce, and each ad is acknowledged once.

---

## Optional: NotionTool MCP server

DSH ships an MCP client (`@deepseek-ai/dsh-mcp-client`), so a local NotionTool
instance can expose its tools — including project memory — directly to the
agent. NotionTool serves streamable HTTP on `127.0.0.1:53768/mcp` and
authenticates with a bearer token.

**1. Get the token.** NotionTool shows it under Settings → Remote MCP access.
The bundled helper decrypts the same value from NotionTool's DPAPI-protected
session file (readable only by your own Windows account):

```powershell
python tools\notiontool-token.py
```

Pass `--data-dir <path>` if NotionTool stores its data somewhere else, or
`--token-only` to print just the token. Keep the token out of the repo.

**2. Store it** in `%USERPROFILE%\.dsh\.env`:

```
NOTIONTOOL_MCP_TOKEN=<token>
```

**3. Register the server** in `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`,
inside the preset's `plugins` list:

```yaml
      - id: mcp-notiontool
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: notiontool
          transport: streamable-http
          url: http://127.0.0.1:53768/mcp
          headers:
            Authorization: !!js '''Bearer '' + process.env.NOTIONTOOL_MCP_TOKEN'
          toolCallTimeoutMs: 120000
          reconnect:
            enabled: true
            maxAttempts: 20
```

Restart DSH afterwards. Tools appear as `mcp__notiontool__<name>`; NotionTool
advertises 36 of them, project memory being `nt_memory_read` and
`nt_memory_update`.

Notes:

- `toolCallTimeoutMs` is raised because NotionTool answers long jobs with
  `still_running` plus a `job_id` (poll with `nt_job_result`) after about 45 s.
- NotionTool must be running. With `reconnect.enabled` DSH re-registers the
  tools when the server comes back.
- `!!js` expressions are evaluated by the profile loader at load time. Values
  under `refs:` in `%USERPROFILE%\.dsh\.credentials.yaml` are **not** copied
  into `process.env`, so name an environment variable (or read the file) rather
  than expecting a credential reference to appear in the environment.

Verify without DSH:

```powershell
node -e "const h={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+require('fs').readFileSync(require('os').homedir()+'/.dsh/.env','utf8').match(/^NOTIONTOOL_MCP_TOKEN=(.+)$/m)[1].trim()};fetch('http://127.0.0.1:53768/mcp',{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(r=>r.text()).then(t=>console.log(t.slice(0,120)))"
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
node tools\freepi-accounts.mjs add         # add an account (opens GitHub in the browser)
node tools\freepi-accounts.mjs add --many  # add several, one after another
node tools\freepi-accounts.mjs use acc-2   # pin an account as active
node tools\freepi-accounts.mjs remove acc-2
node tools\freepi-accounts.mjs import      # seed from free-pi-cli credentials.json
```

Adding an account needs no manual typing: `add` prints the one-time code, copies
it to the clipboard, and opens `github.com/login/device` with the code already
filled in. Pick a GitHub account, confirm, done — the token is stored and the
account is immediately usable. Use `--no-browser` to only print the URL.

On Windows you can also just double-click **`Account-hinzufuegen.cmd`**, which
runs `add --many` and lets you keep adding accounts in a loop.

### Parallelism: one account = one request at a time

free-pi rejects a second simultaneous request per account with

```
429 {"code":"concurrent","message":"one request at a time"}
```

The proxy turns that into real parallelism instead of errors:

* **one lane per account** — with N accounts, N requests run genuinely at the
  same time
* **a FIFO queue for the rest** — extra requests wait for a free lane rather than
  fail (cap: `FREEPI_MAX_QUEUE`, default 64)
* `code: "concurrent"` is retried with backoff and **never** marks an account as
  out of budget (only `402` / a real quota `429` does that)

Check current load:

```powershell
curl http://127.0.0.1:4000/usage     # -> "queue": { inFlight, waiting, lanes }
```

So: a harness running 3 subagents in parallel wants 3 accounts. Everything above
that queues and still completes.

### The other concurrency limit: parallel *sessions*

Separate from `concurrent`, free-pi also caps how many CLI sessions one signed-in
account may have open at once (4). Crashed or abandoned runs keep their slot until
it expires, and the upstream rejection arrives as HTTP **409**:

```
409 {"code":"concurrent_session","retry_after_seconds":1800,...}
```

This is **not** a credit problem and the account is still healthy. The proxy:

* reports it as `429` with the reason spelled out (a bare 409 told you nothing)
* **never** marks the account exhausted for it — doing so would silently retire a
  working account and cost you a whole day of credits
* `retry_after_seconds` in the error says when a slot frees up

The upstream text suggests running `/close-other-session`, which only exists in
the official CLI; here, waiting or switching account is what helps.

`npm test` runs every unit test through `node --test`: the rotation policy
(`tools\test-policy.test.mjs`), the hour-budget arithmetic
(`tools\test-budget.test.mjs`), the store and sponsor/usage paths, the
per-account sponsor windows (`tools\test-sponsor-accounts.test.mjs`), and the
DSH plugin lifecycle. `tools\lib\budget.mjs` holds the pure credit -> hour maths
behind `GET /budget`.

### Running out of budget

The proxy itself never creates accounts; it only tells you when one is needed
and keeps serving from existing accounts otherwise.

#### Manual selection pins your budget

`~/.free-pi/proxy/selected-account.json` pins one account and **disables
rotation**. While it exists, every other account sits idle even when it has
credits left — `nextAction.action` reads `manual` in `GET /usage`. Delete the
file (or run `/freepi-auto`) to let all lanes work again:

```powershell
Remove-Item "$env:USERPROFILE\.free-pi\proxy\selected-account.json"
```

Check `lanes` in `GET /usage`: it should equal the number of usable accounts.

#### Manual route (always works)

When `plan` reports `create a NEW account gh-N@arisya.de`:

1. create a GitHub account using that address (a catch-all domain delivers the
   verification mail to the catch-all mailbox)
2. read the verification link:
   `node tools\fetch-verify-mail.mjs gh-N@arisya.de`
   (configured through `IMAP_USER`, `IMAP_PASS`, `IMAP_HOST`, `IMAP_PORT`)
3. `node tools\freepi-accounts.mjs add` — opens GitHub with the code pre-filled,
   handles the consent step, stores the token

#### Semi-automatic route (`tools\auto-add.mjs`)

`auto-add.mjs` drives the whole chain in a real Chrome window: sign-up form,
mailbox verification, free-pi device flow, consent, and the store write. It
still needs **one human click per account**, because GitHub guards the sign-up
POST with a DataDome CAPTCHA.

```powershell
node tools\auto-add.mjs --count 10 --keep-open   # stop at the first CAPTCHA
node tools\auto-add.mjs --resume                 # continue after solving it
node tools\auto-add.mjs --status                 # what has been minted so far
node tools\auto-add.mjs --forget                 # drop failed rows, keep the counter
```

Why the human click is unavoidable: the sign-up form carries
`octocaptcha-token="datadome-suppressed"`, a placeholder GitHub substitutes when
no real DataDome token was issued. Submitting with it always yields a hard
`t=fe` challenge in a cross-origin `geo.captcha-delivery.com` iframe, which no
script can reach. The challenge is the *interactive* kind, so a human click in
the kept-open window is the legitimate unblock — `--keep-open` and `--resume`
exist for exactly that loop.

The mailbox side is fully automatic: `tools\lib\webmail.mjs` reuses a logged-in
Chrome profile (`~/.free-pi/mail-profile`) and scrapes the verification link
from the STRATO webmail DOM, so no IMAP password is needed.

#### Where the generated passwords go

Every account gets a random password. It is written to
`~/.free-pi/proxy/secrets.json` **before** the sign-up form is submitted, so a
run that dies halfway still leaves you a way back into an account that may
already exist on GitHub. The file is keyed by account id (re-keyed from the
email once the account is stored) and is deliberately separate from
`accounts.json`, which the running proxy rewrites on every usage poll.

```powershell
node tools\freepi-passwords.mjs                  # list account, handle, email
node tools\freepi-passwords.mjs acc-3            # show one password
node tools\freepi-passwords.mjs gh-4@arisya.de   # look up by email
```

The list never prints passwords; you have to name the account. On Windows the
file inherits the profile directory's ACL — `chmod 0600` is only meaningful on
POSIX, so treat it like an SSH key rather than a vault.

---

## Model IDs: validated, not remapped

The proxy forwards the model ID **verbatim, 1:1** to free-pi — it never
rewrites the model name.  Configure opencode to request a free-pi model
directly, for example:

```json
{ "model": "deepseek/deepseek-v4-flash" }
```

### Unknown IDs are rejected up front

free-pi itself does **not** error on an unknown model ID: it silently
substitutes a default and answers `200`, with a *different* `model` string in
the response body. Left alone, that would make the proxy lie to you — you ask
for one model, get another, and nothing reports a problem.

So the proxy checks the requested ID against the live catalog before it claims
an account lane. An unknown ID gets the same answer OpenAI gives:

```json
{
  "error": {
    "message": "The model `deepseek-v4-flsh` does not exist or you do not have access to it. Did you mean `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4.1-flash`? ...",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

HTTP status is `404`, and no account slot is consumed. `GET /v1/models` lists
every accepted ID, in both the raw (`deepseek-v4-flash`) and the slashed
(`deepseek/deepseek-v4-flash`) spelling.

If catalog discovery failed at startup the check is skipped rather than
guessing — an offline start must not reject work that would otherwise succeed.

A *known* ID that free-pi refuses (for example `409` when a model needs
credits) is passed through unchanged, because that is an upstream condition,
not a typo.

### Use the exact id, and expect a canonical name back

Two catalog facts worth knowing, both measured against the live API:

**The catalog has no vendor prefixes.** Every id is bare — `particle`,
`deepseek-v4-flash`, `glm-5.3-flash`. Writing `deepseek/deepseek-v4-flash` is
not a valid id and the upstream rejects it. Earlier versions of this README
showed the slashed form; that was wrong. Use `GET /v1/models` as the source of
truth.

**free-pi answers with a canonical model name, not the id you sent.** Ask for
`deepseek-v4-flash` and a successful response can carry
`"model": "deepseek-ai/deepseek-v41-flash-1017"`; ask for `particle` and you may
get `"model": "particle-ai/particle-1"`. The proxy forwards the upstream body
verbatim, so you will see that name in the response.

This is a label, not an error — but do not build logic that compares the
requested id to `response.model` for equality. If you need to know which model
served a request, keep the id you sent or read the `x-free-pi-account` response
header for the account. The id you send is the one that gets routed; the name
that comes back is free-pi's own canonical spelling of it.

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
