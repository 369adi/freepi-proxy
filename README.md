# freepi-proxy

A zero-dependency OpenAI-compatible proxy for [free-pi-cli](https://github.com/dennisonbertram/free-pi-cli).  
It lets **opencode** (or any OpenAI-API harness) use free-pi as its LLM provider, while:

- **keeping ads** — the proxy polls the free-pi ads endpoint every 30 s and displays them in its own terminal window, maintaining the ethical ad-supported model
- **reusing your existing credentials** — reads `~/.free-pi/agent/credentials.json`, no duplicate login
- **not touching pi's TUI** — you can keep a separate `free-pi-cli` window for its slash-commands if you want

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
| `POST` | `/v1/chat/completions` | Proxies to `api.freepi.ai` with your JWT |

All other paths return 404.

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
