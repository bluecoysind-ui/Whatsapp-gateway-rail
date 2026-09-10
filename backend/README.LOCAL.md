# Chatery WhatsApp API — Local Setup & Working Guide

Local working notes for this clone: how it is configured here, what was changed
and why, how to run it, and what must be fixed before it is deployed anywhere.

The upstream [README.md](README.md) is the full API reference (every endpoint,
request/response shape, WebSocket events). This file does not repeat it — it
covers only what is specific to this machine and the changes made on top.

---

## 1. What this is

An Express 5 + Baileys WhatsApp gateway. It manages multiple WhatsApp sessions,
exposes ~51 REST endpoints under `/api/whatsapp`, pushes real-time events over
socket.io, and serves an admin dashboard.

| Thing | Value here |
|---|---|
| Runtime | Node.js v22 (works on 18+) |
| Port | **3001** (upstream default is 3000 — changed, see below) |
| API docs (Swagger) | http://localhost:3001/ |
| Dashboard | http://localhost:3001/dashboard |
| Old dashboard | http://localhost:3001/dashboard-legacy |
| WebSocket test | http://localhost:3001/ws-test |
| Health | http://localhost:3001/api/health |
| OpenAPI JSON | http://localhost:3001/api-docs.json |

---

## 2. Quick start

```bash
cd chatery_whatsapp
npm install
npm start          # or: npm run dev  (node --watch)
```

Then open http://localhost:3001/dashboard and scan the QR with
WhatsApp → **Linked Devices**. Nothing can be sent until a session is linked.

### Why port 3001

Port 3000 was already taken by an unrelated `node` process on this machine, so
`.env` sets `PORT=3001`. Change it back freely if 3000 is free for you.

---

## 3. Configuration (`.env`)

`.env` is **gitignored** — it exists only on this machine. Shape:

```env
PORT=3001
NODE_ENV=development
CORS_ORIGIN=*

DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=<set your own>

API_KEY=
```

| Variable | Meaning |
|---|---|
| `PORT` | HTTP + WebSocket port |
| `CORS_ORIGIN` | CORS allow-list (`*` = any origin) |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | Credentials for `POST /api/dashboard/login` |
| `API_KEY` | `X-Api-Key` required on every `/api/whatsapp/*` call — **empty disables auth entirely** |

### ⚠ API key authentication is currently OFF

`src/middleware/apiKeyAuth.js` skips authentication when `API_KEY` is empty,
unset, or the literal `your_api_key_here`:

```js
if (!apiKey || apiKey === '' || apiKey === 'your_api_key_here') return next();
```

It was disabled deliberately for local-only use. **Right now any request with no
header at all is accepted.** To re-enable, put any non-empty value back:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
# paste into API_KEY= in .env, then restart
```

and send it as a header on every call:

```bash
curl http://localhost:3001/api/whatsapp/sessions -H "X-Api-Key: <your key>"
```

In Swagger UI, click **Authorize** (top right) and paste the key — otherwise
every "Try it out" returns `401 Missing X-Api-Key header`.

---

## 4. Everyday usage

All examples assume `API_KEY` is empty. If you re-enable it, add
`-H "X-Api-Key: <key>"` to each call.

### Create a session and link WhatsApp

```bash
curl -X POST http://localhost:3001/api/whatsapp/sessions/mysession/connect \
  -H 'Content-Type: application/json'
```

Then fetch the QR and scan it (it rotates every ~20 seconds):

```bash
# as JSON (data:image/png;base64,...)
curl http://localhost:3001/api/whatsapp/sessions/mysession/qr

# as a raw PNG
curl -o qr.png http://localhost:3001/api/whatsapp/sessions/mysession/qr/image
```

The dashboard shows the same QR and refreshes it automatically — easier than
racing the CLI.

### Check status

```bash
curl http://localhost:3001/api/whatsapp/sessions
curl http://localhost:3001/api/whatsapp/sessions/mysession/status
```

`status` moves `connecting` → `qr_ready` → `connected`. Sending only works at
`connected`.

### Send a message

```bash
curl -X POST http://localhost:3001/api/whatsapp/chats/send-text \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"mysession","chatId":"628123456789","message":"Hello World!"}'
```

- `chatId` — plain phone number works (normalised to `...@c.us`); groups end in `@g.us`
- `typingTime` — optional ms of "typing…" before sending
- `replyTo` — optional; must be a **real message ID from that chat's history**,
  otherwise the send fails. Omit it for a first test.

### Common errors and what they mean

| Response | Cause |
|---|---|
| `401 Missing X-Api-Key header` | `API_KEY` is set but the header wasn't sent (in Swagger: click Authorize) |
| `403 Invalid API key` | Header sent, wrong value |
| `404 Session not found` | No session by that `sessionId` — call `/connect` first |
| `400 Session not connected. Please scan QR code first.` | Session exists but WhatsApp isn't linked yet |
| `400 Request body is required` | A `checkSession` route was called with no JSON body |

---

## 5. Changes made to this clone

Four things differ from a fresh `git clone`.

### 5.1 Bug fix — `req.body` undefined on Express 5 (3 routes)

Express 4's `express.json()` set `req.body = {}` when a request had no body;
**Express 5 leaves it `undefined`**. Three routes destructured it unguarded and
returned `500 Cannot destructure property 'metadata' of 'req.body'`.

This broke the workflow the upstream README documents at line 212 — `POST
/sessions/:id/connect` with no body — meaning **no session could be created at
all** on a clean install.

Fixed in `src/routes/whatsapp.js` by defaulting to `{}`:

| Line | Route | Before → after |
|---|---|---|
| 34 | `POST /sessions/:id/connect` | 500 → 200 |
| 94 | `PATCH /sessions/:id/config` | 500 → 200 |
| 132 | `POST /sessions/:id/webhooks` | 500 → 400 (proper validation error) |

The other 39 body-reading routes were already safe: they go through the
`checkSession` middleware, which has an `if (!req.body)` guard (line 301).

### 5.2 The dashboard was replaced

`/dashboard` now serves a React SPA ("WA Gateway") instead of the original
single-file `public/dashboard.html`.

- The built SPA lives in **`public/app/`** (committed — not gitignored)
- Its source is the sibling **`../frontend`** repo
- The original dashboard is preserved at **`/dashboard-legacy`**
  (`public/dashboard-legacy.html`)
- Swagger at `/` is untouched

`index.js` mounts it. Because the SPA references its assets from the site root,
those prefixes are mounted too — none collide with `/`, `/api/*` or `/media`:

```js
app.use('/assets',  express.static(path.join(appDir, 'assets')));
app.use('/avatars', express.static(path.join(appDir, 'avatars')));
app.use('/__grok',  express.static(path.join(appDir, '__grok')));
app.get('/favicon.svg', ...);
app.use('/dashboard', (req, res) => res.sendFile(path.join(appDir, 'index.html')));
```

`app.use` (not `app.get`) is deliberate — Express 5 rejects a bare `'*'`
pattern, and `use` matches every `/dashboard/*` path so the client-side router
can resolve it.

### 5.3 `.env` created

Not in the repo (gitignored). See section 3.

### 5.4 API key disabled

Via `.env` only — **no code was changed**, so this survives `git pull`.

---

## 6. Rebuilding the dashboard after a frontend change

The backend serves a **compiled** bundle. Editing `public/app/` directly is
pointless — it is minified output. Change the source in `../frontend`, then:

```bash
cd ../frontend
npm run build
rm -rf ../chatery_whatsapp/public/app
mkdir -p ../chatery_whatsapp/public/app
cp -r .vercel/output/static/. ../chatery_whatsapp/public/app/
```

Restart the backend and hard-refresh the browser. See the frontend README for
details.

> **Do not delete `../frontend`.** `public/app/` is build output only. Without
> the source the dashboard can never be changed again.

---

## 7. Deployment checklist

Docker files ship with the repo (`Dockerfile`, `docker-compose.yml`). **Do not
deploy in the current configuration.** Fix these first:

- [ ] **Set a real `API_KEY`.** `docker-compose.yml` has `API_KEY=${API_KEY:-}`
      which defaults to **empty** — and empty means *no authentication*. Deployed
      as-is, anyone who finds the URL can send WhatsApp messages from the linked
      account, read chat history, and delete sessions.
- [ ] **Set a real `DASHBOARD_PASSWORD`.** It defaults to `admin123`.
- [ ] **Commit `public/app/`** — it is untracked but not ignored, and the
      dashboard will not exist in the image without it.
- [ ] Restrict `CORS_ORIGIN` to your actual frontend origin instead of `*`.
- [ ] Expect to **re-scan the QR** on the server. `sessions/` and `auth_info/`
      are gitignored and volume-mounted, so linked accounts do not transfer.
- [ ] `npm audit` reports 17 vulnerabilities (2 critical, 10 high) in the
      dependency tree. Left unfixed here because `npm audit fix` may break the
      pinned Baileys/Express versions — review before exposing publicly.

`.dockerignore` excludes only `public/media/*`, so `public/app/` does ship in
the image once committed.

```bash
docker-compose up -d          # reads API_KEY / DASHBOARD_PASSWORD from your env
```

---

## 8. Troubleshooting

**`EADDRINUSE :::3000` (or 3001)** — something else owns the port:

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen |
  Select-Object OwningProcess, @{n='Name';e={(Get-Process -Id $_.OwningProcess).ProcessName}}
```

Either stop that process or change `PORT` in `.env`.

**Everything returns 401** — `API_KEY` is set in `.env`. Send the header, click
Authorize in Swagger, or clear the value.

**Send returns "Session not connected"** — the session exists but WhatsApp is not
linked. Open `/dashboard` and scan the QR.

**QR expired before scanning** — it rotates every ~20 s. Use the dashboard, which
refreshes automatically, rather than a one-shot curl.

**Dashboard is blank or 404s on assets** — `public/app/` is missing or stale.
Rebuild it (section 6).

---

## 9. Layout

```
chatery_whatsapp/
├── index.js                  # server, routes for /, /dashboard, /api/health, ...
├── .env                      # local config (gitignored)
├── public/
│   ├── app/                  # ← built SPA dashboard (from ../frontend)
│   ├── dashboard.html        # original dashboard (unused; kept)
│   ├── dashboard-legacy.html # served at /dashboard-legacy
│   └── websocket-test.html   # served at /ws-test
└── src/
    ├── config/swagger.js         # OpenAPI spec + ApiKeyAuth security scheme
    ├── middleware/apiKeyAuth.js  # X-Api-Key check (skipped when API_KEY empty)
    ├── routes/whatsapp.js        # all 51 /api/whatsapp endpoints
    └── services/whatsapp/        # Baileys session manager, store, formatters
```
