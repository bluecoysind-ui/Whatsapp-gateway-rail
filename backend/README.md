# 🚀 Chatery WhatsApp API

![Chatery](https://sgp.cloud.appwrite.io/v1/storage/buckets/6941a5b70012d918c7aa/files/6941a69000028dec52d2/view?project=694019b0000abc694483&token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ0b2tlbklkIjoiNjk0MWE4NjRjZGNhZGUxOTZmNTMiLCJyZXNvdXJjZUlkIjoiNjk0MWE1YjcwMDEyZDkxOGM3YWE6Njk0MWE2OTAwMDAyOGRlYzUyZDIiLCJyZXNvdXJjZVR5cGUiOiJmaWxlcyIsInJlc291cmNlSW50ZXJuYWxJZCI6IjE0NTE6MSIsImlhdCI6MTc2NTkxMDYyOH0.6DyBMKwzA6x__pQZn3vICDLdBfo0mEUlyMVAc3qEnyo)
A powerful WhatsApp API backend built with Express.js and Baileys library. Supports multi-session management, real-time WebSocket events, group management, and media handling.

![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)
![Express.js](https://img.shields.io/badge/Express.js-5.x-blue.svg)
![Baileys](https://img.shields.io/badge/Baileys-7.x-orange.svg)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.x-purple.svg)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)

---

## 🤝 Sponsor

<table>
  <tr>
    <td align="center" width="160">
      <a href="https://sumopod.com" target="_blank">
        <img src="screenshot/sumopod.png" alt="SumoPod" width="120" /><br/>
      </a>
    </td>
    <td>
      <strong>SumoPod — Container & Application Management</strong><br/>
      SumoPod offers seamless container and application purchasing solutions for businesses of all sizes.<br/><br/>
      <ul>
        <li><strong>Container Marketplace</strong> — Explore and purchase from an extensive container library, all verified and ready for instant deployment.</li>
        <li><strong>One-Click Deployment</strong> — Deploy containers to your infrastructure with one click, eliminating complex configuration processes.</li>
        <li><strong>Automatic Updates</strong> — Keep your containers and applications up to date with automatic version updates and security patches.</li>
      </ul>
      <br/>
      <a href="https://sumopod.com" target="_blank"><strong>✨ Chatery WhatsApp API is available on SumoPod — Deploy with one click, without complex configuration. Includes auto-updates and monitoring. → Get it now</strong></a>
    </td>
  </tr>
</table>

---

## ✨ Features

- 📱 **Multi-Session Support** - Manage multiple WhatsApp accounts simultaneously
- 🔌 **Real-time WebSocket** - Get instant notifications for messages, status updates, and more
- 👥 **Group Management** - Create, manage, and control WhatsApp groups
- 🏷️ **Chat Labels** - Label chats and messages for organization (WhatsApp Business)
- 📨 **Send Messages** - Text, images, documents, locations, contacts, and more
- ↩️ **Reply to Messages** - Reply/quote specific messages with replyTo parameter
- 📊 **Poll Messages** - Send interactive polls with single or multiple choice
- 📤 **Bulk Messaging** - Send messages to multiple recipients with background processing
- 📥 **Auto-Save Media** - Automatically save incoming media to server
- 💾 **Persistent Store** - Message history with optimized caching
- 🔐 **Session Persistence** - Sessions survive server restarts
- 🎛️ **Admin Dashboard** - Web-based dashboard with real-time monitoring and API tester
- 📄 **Swagger UI** - Interactive API documentation at root URL

## 📖 Full Documentation

For complete and detailed documentation, please visit:

| 🌐 Documentation | Link |
|------------------|------|
| **Primary Docs** | [https://docs.chatery.app](https://docs.chatery.app/) |
| **Mirror Docs** | [https://chatery-whatsapp-documentation.appwrite.network](https://chatery-whatsapp-documentation.appwrite.network) |

> 📚 The documentation includes complete API reference, examples, troubleshooting guides, and more.

## 📋 Table of Contents

- [Full Documentation](#-full-documentation)
- [Installation](#-installation)
  - [Standard Installation](#option-1-standard-installation)
  - [Docker Installation](#option-2-docker-installation)
- [Configuration](#-configuration)
- [API Key Authentication](#-api-key-authentication)
- [Quick Start](#-quick-start)
- [Dashboard](#-dashboard)
- [API Documentation](#-api-documentation)
  - [Sessions](#sessions)
  - [Messaging](#messaging)
  - [Bulk Messaging](#bulk-messaging-background-jobs)
  - [Chat History](#chat-history)
  - [Group Management](#group-management)
  - [Labels](#labels-whatsapp-business)
- [WebSocket Events](#-websocket-events)
- [Examples](#-examples)

## 🛠 Installation

### Option 1: Standard Installation

```bash
# Clone the repository
git clone https://github.com/farinchan/chatery_whatsapp.git
cd chatery_whatsapp

# Install dependencies
npm install

# Create environment file
cp .env.example .env

# Start the server
npm start

# Or development mode with auto-reload
npm run dev
```

### Option 2: Docker Installation

```bash
# Clone the repository
git clone https://github.com/farinchan/chatery_whatsapp.git
cd chatery_whatsapp

# Create environment file
cp .env.example .env

# Build and run with Docker Compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down
```

#### Docker Commands

| Command | Description |
|---------|-------------|
| `docker-compose up -d` | Start container in background |
| `docker-compose down` | Stop and remove container |
| `docker-compose logs -f` | View live logs |
| `docker-compose restart` | Restart container |
| `docker-compose build --no-cache` | Rebuild image |

#### Docker Volumes

The following data is persisted across container restarts:

| Volume | Path | Description |
|--------|------|-------------|
| `chatery_sessions` | `/app/sessions` | WhatsApp session data |
| `chatery_media` | `/app/public/media` | Received media files |
| `chatery_store` | `/app/store` | Message history store |

## ⚙ Configuration

Create a `.env` file in the root directory:

```env
PORT=3000
CORS_ORIGIN=*

# Dashboard Authentication
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=securepassword123

# API Key Authentication (optional - leave empty or 'your_api_key_here' to disable)
API_KEY=your_secret_api_key_here

# Proxy check target for POST /proxy/test (must return the caller's IP; JSON {"ip":...} or plain text)
PROXY_CHECK_URL=https://api.ipify.org?format=json
PROXY_CHECK_TIMEOUT_MS=15000

# Bulk messaging limits
BULK_MAX_RECIPIENTS=100
BULK_RECONNECT_WAIT_MS=60000

# Media
UPLOAD_MAX_BYTES=67108864          # max upload size for /media/upload and /chats/send-media (64 MB)
MEDIA_AUTOSAVE_MAX_BYTES=26214400  # incoming media above this is fetched on demand via /chats/media (25 MB)
```

> **Note:** Personal chat IDs use `@c.us` format (e.g., `628123456789@c.us`). Group IDs use `@g.us` format. Phone numbers are automatically normalized (0 → 62).

## 🔐 API Key Authentication

All WhatsApp API endpoints are protected with API key authentication. Include the `X-Api-Key` header in your requests.

### How to Enable

1. Set a strong API key in your `.env` file:
   ```env
   API_KEY=your_super_secret_key_12345
   ```

2. Include the header in all API requests:
   ```bash
   curl -X GET http://localhost:3000/api/whatsapp/sessions \
     -H "X-Api-Key: your_super_secret_key_12345"
   ```

### Disable Authentication

To disable API key authentication, leave `API_KEY` empty or set it to `your_api_key_here` in `.env`:
```env
API_KEY=
# or
API_KEY=your_api_key_here
```

### Error Responses

| Status | Message | Description |
|--------|---------|-------------|
| 401 | Missing X-Api-Key header | API key not provided in request |
| 403 | Invalid API key | API key doesn't match |

### Dashboard Integration

When logging into the dashboard, you'll be prompted to enter your API key (optional). This allows the dashboard to make authenticated API calls.

## 🚀 Quick Start

1. **Start the server**
   ```bash
   npm start
   ```

2. **Create a session**
   ```bash
   curl -X POST http://localhost:3000/api/whatsapp/sessions/mysession/connect \
     -H "X-Api-Key: your_api_key" \
     -H "Content-Type: application/json"
   ```

3. **Get QR Code** - Open in browser or scan
   ```
   http://localhost:3000/api/whatsapp/sessions/mysession/qr/image
   ```
   Note: QR image endpoint also requires API key. Use curl or include header.

4. **Send a message**
   ```bash
   curl -X POST http://localhost:3000/api/whatsapp/chats/send-text \
     -H "X-Api-Key: your_api_key" \
     -H "Content-Type: application/json" \
     -d '{"sessionId": "mysession", "chatId": "628123456789", "message": "Hello!"}'
   ```

---

## 🎛️ Dashboard

Access the admin dashboard at `http://localhost:3000/dashboard`

### 🔐 Authentication

Dashboard requires login with username and password configured in `.env` file.

| Field | Default Value |
|-------|---------------|
| Username | `admin` |
| Password | `admin123` |

### ✨ Dashboard Features

| Feature | Description |
|---------|-------------|
| 📊 **Real-time Stats** | Monitor total sessions, connected/disconnected status, and WebSocket clients |
| 📱 **Session Management** | Create, connect, reconnect, and delete WhatsApp sessions |
| 📷 **QR Code Scanner** | Scan QR codes directly from the dashboard |
| 📡 **Live Events** | Real-time WebSocket event viewer with filtering |
| 💬 **Quick Send** | Send messages quickly to any number |
| 🧪 **API Tester** | Test all 40+ API endpoints with pre-filled templates |
| 📤 **Bulk Messaging** | Send messages to multiple recipients with job tracking |
| 🔗 **Webhook Manager** | Add, remove, and configure webhooks per session |
| 🚪 **Logout** | Secure logout button in header |

### 📸 Screenshots

![Dashboard Screenshot](./screenshot/image.png)

The dashboard provides a modern dark-themed interface:
- **Session Cards** - View all sessions with status indicators
- **QR Modal** - Full-screen QR code for easy scanning
- **Event Log** - Live scrolling event feed with timestamps
- **API Tester** - Dropdown with all endpoints and auto-generated request bodies

---

## 📚 API Documentation

Base URL: `http://localhost:3000/api/whatsapp`

### Sessions

#### List All Sessions
```http
GET /sessions
```

**Response:**
```json
{
  "success": true,
  "message": "Sessions retrieved",
  "data": [
    {
      "sessionId": "mysession",
      "status": "connected",
      "isConnected": true,
      "phoneNumber": "628123456789",
      "name": "John Doe",
      "webhooks": [
        {
          "url": "https://your-server.com/webhook",
          "events": ["message", "message_ack"]
        }
      ],
      "metadata": {
        "userId": "user123",
        "plan": "premium"
      }
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Unique session identifier |
| `status` | string | Current status: `disconnected`, `connecting`, `qr_ready`, `connected` |
| `isConnected` | boolean | Whether session is currently connected |
| `phoneNumber` | string | Connected WhatsApp phone number |
| `name` | string | WhatsApp profile name |
| `webhooks` | array | Configured webhooks for this session |
| `metadata` | object | Custom metadata associated with this session |

#### Create/Connect Session
```http
POST /sessions/:sessionId/connect
```

**Body (Optional):**
```json
{
  "metadata": {
    "userId": "user123",
    "plan": "premium",
    "customField": "any value"
  },
  "webhooks": [
    { "url": "https://your-server.com/webhook", "events": ["all"] },
    { "url": "https://backup-server.com/webhook", "events": ["message"] }
  ]
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `metadata` | object | Optional. Custom metadata to store with session |
| `webhooks` | array | Optional. Array of webhook configs `[{ url, events }]` |

**Response:**
```json
{
  "success": true,
  "message": "Session created",
  "data": {
    "sessionId": "mysession",
    "status": "qr_ready",
    "qrCode": "data:image/png;base64,...",
    "metadata": { "userId": "user123" },
    "webhooks": [
      { "url": "https://your-server.com/webhook", "events": ["all"] }
    ]
  }
}
```

#### Update Session Config
```http
PATCH /sessions/:sessionId/config
```

**Body:**
```json
{
  "metadata": { "newField": "value" },
  "webhooks": [
    { "url": "https://new-webhook.com/endpoint", "events": ["message", "connection.update"] }
  ],
  "proxy": "socks5://user:pass@proxy.example.com:1080",
  "reconnect": true
}
```

All fields are optional; only the ones present are changed. `proxy` accepts a URL or `null` to remove it (see [Per-session proxy](#per-session-proxy)).

**Response:**
```json
{
  "success": true,
  "message": "Proxy saved — reconnecting the session through it",
  "data": {
    "sessionId": "mysession",
    "metadata": { "userId": "user123", "newField": "value" },
    "webhooks": [
      { "url": "https://new-webhook.com/endpoint", "events": ["message", "connection.update"] }
    ],
    "proxy": "socks5://user:***@proxy.example.com:1080",
    "proxyApplied": true
  }
}
```

#### Per-session proxy

Each session can connect through its own proxy, so every linked number can have its own egress IP. The proxy carries **both** the WhatsApp WebSocket and media uploads/downloads, and it is stored in the session's `config.json`, so it survives restarts.

Supported URLs: `socks5://[user:pass@]host:port` (also `socks4://`, `socks5h://`) and `http://[user:pass@]host:port` (HTTP CONNECT; `https://` for a TLS proxy). The password is masked as `***` in every API response.

- Set it when creating the session — `POST /sessions/:id/connect` with `{ "proxy": "..." }` — or later with `PATCH /sessions/:id/config`.
- Changing the proxy on a live session restarts its socket through the new proxy immediately (a few seconds offline, no new QR for a paired session). Pass `"reconnect": false` to only save it for the next connect; the response's `proxyApplied` tells you which happened.
- `GET /sessions` and `GET /sessions/:id/status` include the (masked) `proxy`.
- An invalid URL is rejected with `400` before anything is saved; a session whose stored proxy cannot be built refuses to connect (`status: error`) rather than falling back to the server's own IP.

Rules of thumb from running many accounts: residential or mobile IPs (datacenter ranges are widely flagged), 1–3 accounts per IP, keep an account on the same proxy (IP jumping looks like a hijack), and geo-match the number's country.

#### Test a Proxy
```http
POST /proxy/test
```

**Body:**
```json
{ "proxy": "socks5://user:pass@proxy.example.com:1080" }
```
or `{ "sessionId": "mysession" }` to test the proxy that session already has.

**Response:**
```json
{
  "success": true,
  "message": "Proxy reachable — egress IP 203.0.113.7",
  "data": {
    "ok": true,
    "ip": "203.0.113.7",
    "latencyMs": 412,
    "proxy": "socks5://user:***@proxy.example.com:1080"
  }
}
```

`success` is `false` (still HTTP 200) when the proxy does not answer; `data.error` says why. The check fetches `PROXY_CHECK_URL` (default `https://api.ipify.org?format=json`) through the proxy.

#### Add Webhook
```http
POST /sessions/:sessionId/webhooks
```

**Body:**
```json
{
  "url": "https://another-server.com/webhook",
  "events": ["message", "connection.update"]
}
```

#### Remove Webhook
```http
DELETE /sessions/:sessionId/webhooks
```

**Body:**
```json
{
  "url": "https://another-server.com/webhook"
}
```

#### Get Session Status
```http
GET /sessions/:sessionId/status
```

#### Get QR Code (JSON)
```http
GET /sessions/:sessionId/qr
```

#### Get QR Code (Image)
```http
GET /sessions/:sessionId/qr/image
```
Returns a PNG image that can be displayed directly in browser or scanned.

#### Delete Session
```http
DELETE /sessions/:sessionId
```

---

### Messaging

> **💡 Typing Indicator**: All messaging endpoints support `typingTime` parameter (in milliseconds) to simulate typing before sending the message. This makes the bot appear more human-like.
>
> **↩️ Reply to Message**: All messaging endpoints support `replyTo` parameter to reply to a specific message. Pass the message ID to quote/reply to that message.

#### Send Text Message
```http
POST /chats/send-text
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "message": "Hello, World!",
  "typingTime": 2000,
  "replyTo": "3EB0B430A2B52B67D0"
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number (628xxx) or group ID (xxx@g.us) |
| `message` | string | Required. Text message to send |
| `typingTime` | number | Optional. Typing duration in ms before sending (default: 0) |
| `replyTo` | string | Optional. Message ID to reply to |

#### Send Image
```http
POST /chats/send-image
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "imageUrl": "https://example.com/image.jpg",
  "caption": "Check this out!",
  "typingTime": 1500,
  "replyTo": null
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number or group ID |
| `imageUrl` | string | Required. Direct URL to image file |
| `caption` | string | Optional. Image caption |
| `typingTime` | number | Optional. Typing duration in ms (default: 0) |
| `replyTo` | string | Optional. Message ID to reply to |

#### Send Document
```http
POST /chats/send-document
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "documentUrl": "https://example.com/document.pdf",
  "filename": "document.pdf",
  "mimetype": "application/pdf",
  "caption": "Here is the document you requested",
  "typingTime": 1000,
  "replyTo": null
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number or group ID |
| `documentUrl` | string | Required. Direct URL to document |
| `filename` | string | Required. Filename to display |
| `mimetype` | string | Optional. MIME type (default: application/pdf) |
| `caption` | string | Optional. Caption text for the document |
| `typingTime` | number | Optional. Typing duration in ms (default: 0) |
| `replyTo` | string | Optional. Message ID to reply to |

#### Send Audio
```http
POST /chats/send-audio
```

> ⚠️ **Important:** Audio must be in **OGG format** (.ogg). WhatsApp only supports OGG audio files with Opus codec.
> 
> Convert audio using FFmpeg: `ffmpeg -i input.mp3 -c:a libopus output.ogg`

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "audioUrl": "https://example.com/audio.ogg",
  "ptt": true,
  "typingTime": 1000,
  "replyTo": null
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number or group ID |
| `audioUrl` | string | Required. Direct URL to OGG audio file (.ogg format only) |
| `ptt` | boolean | Optional. Push to talk mode - true = voice note, false = audio file (default: false) |
| `typingTime` | number | Optional. Recording simulation in ms (default: 0) |
| `replyTo` | string | Optional. Message ID to reply to |

#### Send Location
```http
POST /chats/send-location
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "latitude": -6.2088,
  "longitude": 106.8456,
  "name": "Jakarta, Indonesia",
  "typingTime": 1000,
  "replyTo": null
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number or group ID |
| `latitude` | number | Required. GPS latitude |
| `longitude` | number | Required. GPS longitude |
| `name` | string | Optional. Location name |
| `typingTime` | number | Optional. Typing duration in ms (default: 0) |
| `replyTo` | string | Optional. Message ID to reply to |

#### Send Contact
```http
POST /chats/send-contact
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "contactName": "John Doe",
  "contactPhone": "628987654321",
  "typingTime": 500,
  "replyTo": null
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number or group ID |
| `contactName` | string | Required. Contact display name |
| `contactPhone` | string | Required. Contact phone number |
| `typingTime` | number | Optional. Typing duration in ms (default: 0) |
| `replyTo` | string | Optional. Message ID to reply to |

#### Send Poll Message
```http
POST /chats/send-poll
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "question": "What is your favorite color?",
  "options": ["Red", "Blue", "Green", "Yellow"],
  "selectableCount": 1,
  "typingTime": 2000,
  "replyTo": null
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number or group ID |
| `question` | string | Required. Poll question |
| `options` | array | Required. Array of options (2-12 items) |
| `selectableCount` | number | Optional. Number of selectable options (default: 1) |
| `typingTime` | number | Optional. Typing duration in ms (default: 0) |
| `replyTo` | string | Optional. Message ID to reply to |

#### Send Button Message (DEPRECATED)
```http
POST /chats/send-button
```

> ⚠️ **Note:** WhatsApp deprecated button messages in 2022. This endpoint now uses **Poll** as an alternative. For actual interactive buttons, you need WhatsApp Business API (Cloud API).

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "text": "Please choose an option:",
  "footer": "Powered by Chatery",
  "buttons": ["Option 1", "Option 2", "Option 3"],
  "typingTime": 2000,
  "replyTo": null
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number or group ID |
| `text` | string | Required. Poll question (combined with footer) |
| `footer` | string | Optional. Additional text |
| `buttons` | array | Required. Array of options (poll choices) |
| `typingTime` | number | Optional. Typing duration in ms (default: 0) |
| `replyTo` | string | Optional. Message ID to reply to |

#### Send Presence Update
```http
POST /chats/presence
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "presence": "composing"
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number or group ID |
| `presence` | string | Required. `composing`, `recording`, `paused`, `available`, `unavailable` |

#### Check Phone Number
```http
POST /chats/check-number
```

**Body:**
```json
{
  "sessionId": "mysession",
  "phone": "628123456789"
}
```

#### Get Profile Picture
```http
POST /chats/profile-picture
```

**Body:**
```json
{
  "sessionId": "mysession",
  "phone": "628123456789"
}
```

---

### Bulk Messaging (Background Jobs)

Bulk messaging runs in the background and returns immediately with a job ID. You can track progress using the status endpoint, the `bulk.progress` / `bulk.completed` WebSocket events, or the **Broadcast** panel in the dashboard.

> **⚡ Background Processing**: All bulk endpoints return immediately with a `jobId`. Messages are sent one at a time in the background to avoid request timeouts.

**Multiple sending accounts (rotation).** Pass `sessionIds` (an array) instead of a single `sessionId` and the recipients are spread **round-robin** across those accounts — account 1 gets recipient 1, account 2 gets recipient 2, and so on. Because each session carries its own [proxy](#per-session-proxy), consecutive messages leave through different IPs automatically. The job is owned by the first account (its history lives there); every recipient's `via` records which account sent it, and `perSession` tallies each one. A single `sessionId` still works and behaves as a one-account campaign.

How a job behaves:

- Recipients are trimmed and de-duplicated; max 100 per job (`BULK_MAX_RECIPIENTS`).
- Only connected accounts become lanes; disconnected ones in `sessionIds` are reported in the response's `skippedSessions`. If none are connected the request is rejected with `400`.
- If a lane drops mid-campaign it is skipped and the other lanes keep sending; the job only pauses/`interrupted`s when **every** lane is disconnected.
- Between messages the sender waits `delayBetweenMessages` plus a random `0..delayJitter` ms — vary the pacing, WhatsApp flags bursts of identical messages.
- If the session drops mid-job, the job pauses for up to 60s (`BULK_RECONNECT_WAIT_MS`) waiting for it to reconnect, then gives up as `interrupted`.
- A job can be cancelled; the recipients not yet attempted are recorded as `skipped`.
- History is kept in `sessions/<sessionId>/bulk-jobs.json` (last 100 jobs per session). After a server restart, jobs that were running are marked `interrupted` — nothing is silently lost, and `retry` picks up the unsent recipients.

#### Send Bulk Text Message
```http
POST /chats/send-bulk
```

**Body:**
```json
{
  "sessionId": "mysession",
  "recipients": ["628123456789", "628987654321", "628111222333"],
  "message": "Hello! This is a bulk message.",
  "name": "September promo",
  "sessionIds": ["accountA", "accountB"],
  "delayBetweenMessages": 3000,
  "delayJitter": 2000,
  "typingTime": 0
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionIds` | array | Accounts to send from; recipients are rotated round-robin across them. Use this **or** `sessionId`. |
| `sessionId` | string | A single sending account (equivalent to `sessionIds: [sessionId]`) |
| `recipients` | array | Required. Array of phone numbers or JIDs (max 100) |
| `message` | string | Required. Text message to send |
| `name` | string | Optional. Label shown in the dashboard |
| `delayBetweenMessages` | number | Optional. Base delay between messages in ms (default: 1000) |
| `delayJitter` | number | Optional. Random extra delay of 0..N ms added to each gap (default: 0) |
| `typingTime` | number | Optional. Typing indicator duration in ms (default: 0) |

**Response:**
```json
{
  "success": true,
  "message": "Bulk message job started. Check status with jobId.",
  "data": {
    "jobId": "bulk_1704326400000_abc123def",
    "total": 3,
    "statusUrl": "/api/whatsapp/chats/bulk-status/bulk_1704326400000_abc123def"
  }
}
```

#### Send Bulk Image
```http
POST /chats/send-bulk-image
```

**Body:**
```json
{
  "sessionId": "mysession",
  "recipients": ["628123456789", "628987654321"],
  "imageUrl": "https://example.com/image.jpg",
  "caption": "Check out this image!",
  "delayBetweenMessages": 3000,
  "delayJitter": 2000,
  "typingTime": 0
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `recipients` | array | Required. Array of phone numbers or JIDs (max 100) |
| `imageUrl` | string | Required. Direct URL to image file |
| `caption` | string | Optional. Image caption |
| `name` | string | Optional. Label shown in the dashboard |
| `delayBetweenMessages` | number | Optional. Base delay between messages in ms (default: 1000) |
| `delayJitter` | number | Optional. Random extra delay of 0..N ms (default: 0) |
| `typingTime` | number | Optional. Typing indicator duration in ms (default: 0) |

#### Send Bulk Document
```http
POST /chats/send-bulk-document
```

**Body:**
```json
{
  "sessionId": "mysession",
  "recipients": ["628123456789", "628987654321"],
  "documentUrl": "https://example.com/document.pdf",
  "filename": "document.pdf",
  "mimetype": "application/pdf",
  "caption": "Here is the brochure",
  "delayBetweenMessages": 3000,
  "delayJitter": 2000,
  "typingTime": 0
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `recipients` | array | Required. Array of phone numbers or JIDs (max 100) |
| `documentUrl` | string | Required. Direct URL to document |
| `filename` | string | Required. Filename to display |
| `mimetype` | string | Optional. MIME type (default: application/pdf) |
| `caption` | string | Optional. Caption under the document |
| `name` | string | Optional. Label shown in the dashboard |
| `delayBetweenMessages` | number | Optional. Base delay between messages in ms (default: 1000) |
| `delayJitter` | number | Optional. Random extra delay of 0..N ms (default: 0) |
| `typingTime` | number | Optional. Typing indicator duration in ms (default: 0) |

#### Get Bulk Job Status
```http
GET /chats/bulk-status/:jobId
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "bulk_1704326400000_abc123def",
    "sessionId": "mysession",
    "type": "text",
    "name": "September promo",
    "status": "processing",
    "total": 50,
    "sent": 25,
    "failed": 2,
    "skipped": 0,
    "progress": 54,
    "cancelRequested": false,
    "error": null,
    "payload": { "message": "Hello! This is a bulk message." },
    "options": { "delayBetweenMessages": 3000, "delayJitter": 2000, "typingTime": 0 },
    "recipients": ["628123456789", "628987654321", "..."],
    "details": [
      {
        "recipient": "628123456789",
        "status": "sent",
        "messageId": "ABC123",
        "timestamp": "2026-01-04T10:00:00.000Z"
      },
      {
        "recipient": "628987654321",
        "status": "failed",
        "error": "Number not registered",
        "timestamp": "2026-01-04T10:00:01.000Z"
      }
    ],
    "createdAt": "2026-01-04T10:00:00.000Z",
    "startedAt": "2026-01-04T10:00:00.000Z",
    "completedAt": null
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `processing`, `completed` (every recipient attempted — check `failed`), `cancelled`, or `interrupted` (session stayed disconnected / server restarted) |
| `progress` | number | Progress percentage (0-100) |
| `sent` | number | Successfully sent count |
| `failed` | number | Send attempted and rejected |
| `skipped` | number | Never attempted (job cancelled or interrupted) |
| `error` | string | Why the job stopped early, when it did |
| `details` | array | Per-recipient `sent` / `failed` / `skipped` with timestamps |

#### Cancel a Bulk Job
```http
POST /chats/bulk-jobs/:jobId/cancel
```

Stops the job after the message currently in flight. Returns the job summary; `409` if it had already finished.

#### Retry Unsent Recipients
```http
POST /chats/bulk-jobs/:jobId/retry
```

**Body:**
```json
{
  "sessionId": "mysession"
}
```

Starts a **new** job with the same content and pacing for every recipient marked `failed` or `skipped` in the source job. Returns the new `jobId` plus `retryOf`; `400` if there is nothing to retry, `409` if the source job is still running.

#### Get All Bulk Jobs
```http
POST /chats/bulk-jobs
```

Returns the last 50 jobs for the session, newest first, without the per-recipient `details` / `recipients` arrays. Only requires the session to exist, so history is readable while the phone is offline.

**Body:**
```json
{
  "sessionId": "mysession"
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "jobId": "bulk_1704326400000_abc123def",
      "type": "text",
      "status": "completed",
      "total": 50,
      "sent": 48,
      "failed": 2,
      "progress": 100,
      "createdAt": "2026-01-04T10:00:00.000Z",
      "completedAt": "2026-01-04T10:02:30.000Z"
    }
  ]
}
```

---

### Scrapers & Address Book

#### Scrape Contacts
```http
POST /contacts/scrape
```
Body: `{ "sessionIds": ["accountA","accountB"], "dedupe": true }` (or a single `sessionId`). Returns every saved contact across the selected connected accounts. With `dedupe` (default), a number seen on several accounts appears once with a `sources` array. The dashboard's **Scrapers → Contact Scraper** exports the result to CSV.

#### List Groups
```http
POST /groups/list
```
Body: `{ "sessionId": "accountA" }` — the account's groups, for picking before a group scrape.

#### Scrape Group Members
```http
POST /groups/scrape
```
Body: `{ "sessionId": "accountA", "groupIds": ["<jid>", "<jid>"] }` for chosen groups, or omit `groupIds` to scrape **all** groups on the account. `sessionIds` works too for several accounts at once. Each member row has `phone`, `name` (if known), `admin`, and `groupName`.

#### Save a Contact
```http
POST /contacts/save
```
Body: `{ "sessionId", "phone", "name" }` — saves the number to that account's WhatsApp address book (app-state sync, `saveOnPrimaryAddressbook`).

#### Add Contacts to a Group
```http
POST /contacts/add-to-group
```
Body: `{ "sessionId", "groupId", "phones": ["628...","628..."], "name" }` (or a single `phone`). For each number it **saves the contact first, then adds it to the group** — the flow point (3) asks for. Returns a per-number result; `success` is true when at least one was added.

> Group adds are subject to WhatsApp's rules: you must be an admin of the group, and numbers with "only contacts/admins can add me" privacy will land as an invite rather than a direct add (reflected in each result's status).

### Chat History

#### Get Chats Overview
```http
POST /chats/overview
```

**Body:**
```json
{
  "sessionId": "mysession",
  "limit": 50,
  "offset": 0,
  "type": "all"
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `limit` | number | Optional. Max results (default: 50) |
| `offset` | number | Optional. Pagination offset (default: 0) |
| `type` | string | Optional. Filter: `all`, `personal`, `group` |

#### Get Contacts
```http
POST /contacts
```

**Body:**
```json
{
  "sessionId": "mysession",
  "limit": 100,
  "offset": 0,
  "search": "john"
}
```

#### Get Chat Messages
```http
POST /chats/messages
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789@c.us",
  "limit": 50,
  "cursor": null
}
```

#### Get Message Media (download on demand)
```http
POST /chats/media
```

**Body:**
```json
{ "sessionId": "mysession", "chatId": "628123456789@c.us", "messageId": "3EB0B430A2B52B67D0" }
```

Returns `{ url, mimetype, filename, size }` where `url` is a `/media/...` path served by this server. Incoming media up to `MEDIA_AUTOSAVE_MAX_BYTES` is saved as it arrives (and already has `mediaUrl` in `/chats/messages`); larger files and messages from before the gateway was running are downloaded from WhatsApp on the first call. The dashboard's **Load** button on a message uses this.

Files are stored as `public/media/<sessionId>/<chatId>/<messageId>.<ext>`; the original name is returned as `filename`.

#### Upload a File
```http
POST /media/upload
Content-Type: multipart/form-data
```

Fields: `sessionId` (send it **before** the file), `file`. Returns `{ url, filename, mimetype, size }`; the `/media/...` URL is accepted anywhere a media URL is — `send-image`, `send-video`, `send-document`, `send-audio` and the bulk endpoints — so a file can be uploaded once and sent many times. Max size `UPLOAD_MAX_BYTES` (64 MB).

#### Send a File (upload + send)
```http
POST /chats/send-media
Content-Type: multipart/form-data
```

Fields: `sessionId`, `chatId`, `file`, optional `caption`, `typingTime`, `replyTo`, `ptt` (voice note), `asDocument` (send an image/video as a file). The message kind follows the mimetype: `image/*` → image, `video/*` → video, `audio/*` → audio, else document. This is what the dashboard's 📎 button calls.

#### Send Video
```http
POST /chats/send-video
```

**Body:** `{ "sessionId", "chatId", "videoUrl", "caption"?, "gifPlayback"?, "typingTime"?, "replyTo"? }`

#### Get Chat Info
```http
POST /chats/info
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789@c.us"
}
```

#### Mark Chat as Read
```http
POST /chats/mark-read
```

Mark all unread messages in a chat as read. Works for both personal and group chats.

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789"
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `chatId` | string | Required. Phone number or group ID (`@c.us` or `@g.us`) |

**Response:**
```json
{
  "success": true,
  "message": "Chat marked as read",
  "data": {
    "chatId": "628123456789@c.us",
    "isGroup": false,
    "markedCount": 5
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `chatId` | string | Chat ID that was marked as read |
| `isGroup` | boolean | Whether the chat is a group |
| `markedCount` | number | Number of messages marked as read |

> **Note:** Messages must be received after the server starts to be in the store. If `markedCount` is 0, there were no unread messages in the store.

---

### Group Management

#### Get All Groups
```http
POST /groups
```

**Body:**
```json
{
  "sessionId": "mysession"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "count": 5,
    "groups": [
      {
        "id": "123456789@g.us",
        "subject": "My Group",
        "participantsCount": 25,
        "creation": 1609459200
      }
    ]
  }
}
```

#### Create Group
```http
POST /groups/create
```

**Body:**
```json
{
  "sessionId": "mysession",
  "name": "My New Group",
  "participants": ["628123456789", "628987654321"]
}
```

#### Get Group Metadata
```http
POST /groups/metadata
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "123456789@g.us",
    "subject": "My Group",
    "description": "Group description",
    "participants": [
      { "id": "628123456789@c.us", "admin": "superadmin" },
      { "id": "628987654321@c.us", "admin": null }
    ],
    "size": 25
  }
}
```

#### Add Participants
```http
POST /groups/participants/add
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us",
  "participants": ["628111222333", "628444555666"]
}
```

#### Remove Participants
```http
POST /groups/participants/remove
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us",
  "participants": ["628111222333"]
}
```

#### Promote to Admin
```http
POST /groups/participants/promote
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us",
  "participants": ["628111222333"]
}
```

#### Demote from Admin
```http
POST /groups/participants/demote
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us",
  "participants": ["628111222333"]
}
```

#### Update Group Subject (Name)
```http
POST /groups/subject
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us",
  "subject": "New Group Name"
}
```

#### Update Group Description
```http
POST /groups/description
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us",
  "description": "This is the new group description"
}
```

#### Update Group Settings
```http
POST /groups/settings
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us",
  "setting": "announcement"
}
```

| Setting | Description |
|---------|-------------|
| `announcement` | Only admins can send messages |
| `not_announcement` | All participants can send messages |
| `locked` | Only admins can edit group info |
| `unlocked` | All participants can edit group info |

#### Update Group Picture
```http
POST /groups/picture
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us",
  "imageUrl": "https://example.com/group-pic.jpg"
}
```

#### Leave Group
```http
POST /groups/leave
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us"
}
```

#### Join Group via Invite
```http
POST /groups/join
```

**Body:**
```json
{
  "sessionId": "mysession",
  "inviteCode": "https://chat.whatsapp.com/AbCdEfGhIjKlMn"
}
```

#### Get Invite Code
```http
POST /groups/invite-code
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "groupId": "123456789@g.us",
    "inviteCode": "AbCdEfGhIjKlMn",
    "inviteLink": "https://chat.whatsapp.com/AbCdEfGhIjKlMn"
  }
}
```

#### Revoke Invite Code
```http
POST /groups/revoke-invite
```

**Body:**
```json
{
  "sessionId": "mysession",
  "groupId": "123456789@g.us"
}
```

---

## 🏷️ Labels (WhatsApp Business)

WhatsApp Business labels help you organize and categorize chats. Available only for WhatsApp Business accounts.

### Get All Labels
```http
POST /labels
```

**Body:**
```json
{
  "sessionId": "mysession"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "labels": [
      { "id": "1", "name": "New Customer", "color": 0 },
      { "id": "2", "name": "VIP", "color": 5 }
    ],
    "count": 2
  }
}
```

### Create/Update Label
```http
POST /labels/create
```

**Body:**
```json
{
  "sessionId": "mysession",
  "name": "My Label",
  "colorId": 3,
  "labelId": null
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `sessionId` | string | Required. Session ID |
| `name` | string | Required. Label name |
| `colorId` | number | Optional. Color ID (0-19), default: 0 |
| `labelId` | string | Optional. Existing label ID to update |

**Response:**
```json
{
  "success": true,
  "message": "Label created successfully",
  "data": {
    "labelId": "3",
    "name": "My Label",
    "color": 3
  }
}
```

### Delete Label
```http
POST /labels/delete
```

**Body:**
```json
{
  "sessionId": "mysession",
  "labelId": "3"
}
```

### Add Label to Chat
```http
POST /labels/chat/add
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "labelId": "3"
}
```

### Remove Label from Chat
```http
POST /labels/chat/remove
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789",
  "labelId": "3"
}
```

### Get Labels for Chat
```http
POST /labels/chat
```

**Body:**
```json
{
  "sessionId": "mysession",
  "chatId": "628123456789"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "chatId": "628123456789@c.us",
    "labels": [
      { "id": "3", "name": "My Label", "color": 3 }
    ]
  }
}
```

> **Note:** Labels are only available for WhatsApp Business accounts. Personal accounts cannot use labels.

---

## 🔌 WebSocket Events

Connect to WebSocket server at `ws://localhost:3000`

### Connection

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');

// Subscribe to a session
socket.emit('subscribe', 'mysession');

// Unsubscribe from a session
socket.emit('unsubscribe', 'mysession');
```

### Events

| Event | Description | Payload |
|-------|-------------|---------|
| `qr` | QR code generated | `{ sessionId, qrCode, timestamp }` |
| `connection.update` | Connection status changed | `{ sessionId, status, phoneNumber?, name?, timestamp }` |
| `message` | New message received | `{ sessionId, message, timestamp }` |
| `message.sent` | Message sent confirmation | `{ sessionId, message, timestamp }` |
| `message.update` | Message status update (read, delivered) | `{ sessionId, update, timestamp }` |
| `message.reaction` | Message reaction added | `{ sessionId, reactions, timestamp }` |
| `message.revoke` | Message deleted/revoked | `{ sessionId, key, participant, timestamp }` |
| `chat.update` | Chat updated | `{ sessionId, chats, timestamp }` |
| `chat.upsert` | New chat created | `{ sessionId, chats, timestamp }` |
| `chat.delete` | Chat deleted | `{ sessionId, chatIds, timestamp }` |
| `contact.update` | Contact updated | `{ sessionId, contacts, timestamp }` |
| `presence.update` | Typing, online status | `{ sessionId, presence, timestamp }` |
| `group.participants` | Group members changed | `{ sessionId, update, timestamp }` |
| `group.update` | Group info changed | `{ sessionId, update, timestamp }` |
| `call` | Incoming call | `{ sessionId, call, timestamp }` |
| `labels` | Labels updated (business) | `{ sessionId, labels, timestamp }` |
| `logged.out` | Session logged out | `{ sessionId, message, timestamp }` |
| `session.status` | Every status transition, **also broadcast to all clients** (no subscribe needed): connecting, qr_ready, qr_expired, connected, disconnected, logged_out, deleted | `{ sessionId, status, phoneNumber?, name?, reason?, timestamp }` |
| `session.connected` | An account finished linking / came back online (room + broadcast) | `{ sessionId, phoneNumber, name, timestamp }` |
| `session.disconnected` | A previously connected account went away (room + broadcast) | `{ sessionId, phoneNumber, name, reason, loggedOut, willReconnect, timestamp }` |
| `bulk.progress` | A bulk job sent (or failed) one recipient | `{ sessionId, job, last, timestamp }` — `job` is the summary, `last` the recipient just attempted |
| `bulk.completed` | A bulk job finished (`completed`, `cancelled` or `interrupted`) | `{ sessionId, job, timestamp }` |

### Example: Listen for Messages

```javascript
const socket = io('http://localhost:3000');

socket.on('connect', () => {
  console.log('Connected to WebSocket');
  socket.emit('subscribe', 'mysession');
});

socket.on('message', (data) => {
  console.log('New message:', data.message);
  // {
  //   sessionId: 'mysession',
  //   message: {
  //     id: 'ABC123',
  //     from: '628123456789@c.us',
  //     text: 'Hello!',
  //     timestamp: 1234567890,
  //     ...
  //   },
  //   timestamp: '2024-01-15T10:30:00.000Z'
  // }
});

socket.on('qr', (data) => {
  console.log('Scan QR Code:', data.qrCode);
});

socket.on('connection.update', (data) => {
  console.log('Connection status:', data.status);
  if (data.status === 'connected') {
    console.log(`Connected as ${data.name} (${data.phoneNumber})`);
  }
});
```

### WebSocket Test Page

Open `http://localhost:3000/ws-test` in your browser for an interactive WebSocket testing interface.

---

## 🪝 Webhooks

You can configure multiple webhook URLs to receive events from your WhatsApp session. Each webhook can subscribe to specific events.

### Setup Multiple Webhooks

Set webhooks when creating or updating a session:

```bash
# When creating session with multiple webhooks
curl -X POST http://localhost:3000/api/whatsapp/sessions/mysession/connect \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": { "userId": "123" },
    "webhooks": [
      { "url": "https://primary-server.com/webhook", "events": ["all"] },
      { "url": "https://analytics.example.com/webhook", "events": ["message"] },
      { "url": "https://backup.example.com/webhook", "events": ["connection.update"] }
    ]
  }'

# Add a webhook to existing session
curl -X POST http://localhost:3000/api/whatsapp/sessions/mysession/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://new-webhook.com/endpoint",
    "events": ["message", "connection.update"]
  }'

# Remove a webhook
curl -X DELETE http://localhost:3000/api/whatsapp/sessions/mysession/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://new-webhook.com/endpoint"
  }'

# Update all webhooks
curl -X PATCH http://localhost:3000/api/whatsapp/sessions/mysession/config \
  -H "Content-Type: application/json" \
  -d '{
    "webhooks": [
      { "url": "https://only-this-one.com/webhook", "events": ["all"] }
    ]
  }'
```

### Webhook Payload

All configured webhook endpoints will receive POST requests with this format:

```json
{
  "event": "message",
  "sessionId": "mysession",
  "metadata": {
    "userId": "123",
    "customField": "value"
  },
  "data": {
    "id": "ABC123",
    "from": "628123456789@c.us",
    "text": "Hello!",
    "timestamp": 1234567890
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Webhook Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-Webhook-Source` | `chatery-whatsapp-api` |
| `X-Session-Id` | Session ID |
| `X-Webhook-Event` | Event name |

### Available Webhook Events

| Event | Description |
|-------|-------------|
| `connection.update` | Connection status changed (connected, disconnected) |
| `message` | New message received |
| `message.sent` | Message sent confirmation |
| `session.connected` | An account finished linking / came back online — `{ sessionId, phoneNumber, name, timestamp }` |
| `session.disconnected` | A previously connected account went away — `{ sessionId, phoneNumber, name, reason, loggedOut, willReconnect, timestamp }`. `loggedOut: true` means the phone unlinked the device (it will not come back by itself); `willReconnect: true` means the gateway is retrying a dropped socket. |
| `bulk.completed` | A bulk messaging job finished (payload: the job summary) |

> **Extension point.** Both session events go through one plain function each in
> [`src/services/whatsapp/sessionEvents.js`](src/services/whatsapp/sessionEvents.js)
> (`onSessionConnected`, `onSessionDisconnected`). Today they log
> `🔴 User <name> (<phone>) logged out` and forward to webhooks/WebSocket; add your
> own API call there (marked `TODO(callback)`) to notify a CRM, billing, alerting, etc.

Set `events: ["all"]` to receive all events, or specify individual events per webhook.

### WebSocket Stats

```http
GET /api/websocket/stats
```

**Response:**
```json
{
  "success": true,
  "data": {
    "totalConnections": 5,
    "sessionRooms": {
      "mysession": 2,
      "othersession": 1
    }
  }
}
```

---

## 📁 Project Structure

```
chatery_backend/
├── index.js                 # Application entry point
├── package.json
├── .env                     # Environment variables
├── README.md                # Documentation
├── public/
│   ├── dashboard.html       # Admin dashboard
│   ├── websocket-test.html  # WebSocket test page
│   └── media/               # Auto-saved media files
│       └── {sessionId}/
│           └── {chatId}/
├── sessions/                # Session authentication data
│   └── {sessionId}/
│       ├── creds.json
│       └── store.json
└── src/
    ├── routes/
    │   └── whatsapp.js      # API routes
    └── services/
        ├── websocket/
        │   └── WebSocketManager.js
        └── whatsapp/
            ├── index.js
            ├── WhatsAppManager.js
            ├── WhatsAppSession.js
            ├── BaileysStore.js
            └── MessageFormatter.js
```

---

## 📝 Examples

### Node.js Client

```javascript
const axios = require('axios');

const API_URL = 'http://localhost:3000/api/whatsapp';

// Create session
async function createSession(sessionId) {
  const response = await axios.post(`${API_URL}/sessions/${sessionId}/connect`);
  return response.data;
}

// Send message
async function sendMessage(sessionId, to, message) {
  const response = await axios.post(`${API_URL}/chats/send-text`, {
    sessionId,
    to,
    message
  });
  return response.data;
}

// Get all groups
async function getGroups(sessionId) {
  const response = await axios.post(`${API_URL}/groups`, { sessionId });
  return response.data;
}
```

### Python Client

```python
import requests

API_URL = 'http://localhost:3000/api/whatsapp'

# Create session
def create_session(session_id):
    response = requests.post(f'{API_URL}/sessions/{session_id}/connect')
    return response.json()

# Send message
def send_message(session_id, to, message):
    response = requests.post(f'{API_URL}/chats/send-text', json={
        'sessionId': session_id,
        'to': to,
        'message': message
    })
    return response.json()

# Get all groups
def get_groups(session_id):
    response = requests.post(f'{API_URL}/groups', json={
        'sessionId': session_id
    })
    return response.json()
```

---

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## ☕ Support & Donate

If you find this project helpful, consider supporting the development:

<p align="center">
  <a href="https://saweria.co/https://saweria.co/fajrichan">
    <img src="https://img.shields.io/badge/Saweria-Buy%20Me%20a%20Coffee-orange?style=for-the-badge&logo=ko-fi" alt="Saweria" />
  </a>
  <a href="https://paypal.me/farinchan">
    <img src="https://img.shields.io/badge/PayPal-Donate-blue?style=for-the-badge&logo=paypal" alt="PayPal" />
  </a>
  
</p>

<p align="center">
  <a href="https://github.com/farinchan/chatery_whatsapp">
    <img src="https://img.shields.io/github/stars/farinchan/chatery_whatsapp?style=social" alt="GitHub Stars" />
  </a>
  <a href="https://github.com/farinchan/chatery_whatsapp/fork">
    <img src="https://img.shields.io/github/forks/farinchan/chatery_whatsapp?style=social" alt="GitHub Forks" />
  </a>
</p>

Your support helps me maintain and improve this project! ❤️

---

## 👨‍💻 Author

**Fajri Rinaldi Chan** (Farin Chan)

<p align="left">
  <a href="https://github.com/farinchan">
    <img src="https://img.shields.io/badge/GitHub-@farinchan-181717?style=for-the-badge&logo=github" alt="GitHub" />
  </a>
  <a href="https://www.linkedin.com/in/fajri-chan">
    <img src="https://img.shields.io/badge/LinkedIn-farinchan-0077B5?style=for-the-badge&logo=linkedin" alt="LinkedIn" />
  </a>
  <a href="https://www.instagram.com/fajri_chan">
    <img src="https://img.shields.io/badge/Instagram-@farinchan-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram" />
  </a>
</p>

---

## 🔗 Quick Links

| Resource | URL |
|----------|-----|
| 📄 Swagger UI (API Docs) | http://localhost:3000 |
| 🎛️ Dashboard | http://localhost:3000/dashboard |
| 📚 API Base URL | http://localhost:3000/api/whatsapp |
| 🔌 WebSocket Test | http://localhost:3000/ws-test |
| 📊 WebSocket Stats | http://localhost:3000/api/websocket/stats |
| ❤️ Health Check | http://localhost:3000/api/health |
| 📋 OpenAPI JSON | http://localhost:3000/api-docs.json |

---

## ⚠️ Disclaimer

This project is not affiliated with WhatsApp or Meta. Use at your own risk. Make sure to comply with WhatsApp's Terms of Service.
