/**
 * Gateway API client extracted from the original Chatery dashboard.
 * Talks to /api/whatsapp, which the backend serves directly (or the app's
 * proxy routes forward to it in standalone dev).
 */

export const API_BASE = "/api/whatsapp";

export type SessionStatus =
  | "connected"
  | "disconnected"
  | "connecting"
  | "qr_ready"
  | "qr_expired"
  | "logged_out";

export type GatewaySession = {
  sessionId: string;
  name?: string;
  phoneNumber?: string;
  status: SessionStatus;
  webhooks?: Array<{ url: string; events?: string[] }>;
  /** Redacted proxy URL (password masked) the session connects through, or null. */
  proxy?: string | null;
};

export type GatewayEvent = {
  id: string;
  time: string;
  type: "message" | "connection" | "qr" | "error";
  content: string;
};

export type EndpointDef = {
  value: string;
  label: string;
  group: string;
};

export const API_ENDPOINTS: EndpointDef[] = [
  { group: "Sessions", value: "GET|/api/whatsapp/sessions", label: "GET /sessions - List all sessions" },
  { group: "Sessions", value: "GET|/api/whatsapp/sessions/{sessionId}/status", label: "GET /sessions/:id/status" },
  { group: "Sessions", value: "GET|/api/whatsapp/sessions/{sessionId}/qr", label: "GET /sessions/:id/qr" },
  { group: "Sessions", value: "GET|/api/whatsapp/sessions/{sessionId}/qr/image", label: "GET /sessions/:id/qr/image" },
  { group: "Sessions", value: "POST|/api/whatsapp/sessions/{sessionId}/connect", label: "POST /sessions/:id/connect" },
  { group: "Sessions", value: "PATCH|/api/whatsapp/sessions/{sessionId}/config", label: "PATCH /sessions/:id/config" },
  { group: "Sessions", value: "POST|/api/whatsapp/sessions/{sessionId}/webhooks", label: "POST /sessions/:id/webhooks" },
  { group: "Sessions", value: "DELETE|/api/whatsapp/sessions/{sessionId}/webhooks", label: "DELETE /sessions/:id/webhooks" },
  { group: "Sessions", value: "DELETE|/api/whatsapp/sessions/{sessionId}", label: "DELETE /sessions/:id" },
  { group: "Sessions", value: "POST|/api/whatsapp/proxy/test", label: "POST /proxy/test - Check a proxy" },
  { group: "Messaging", value: "POST|/api/whatsapp/chats/send-text", label: "POST /chats/send-text" },
  { group: "Messaging", value: "POST|/api/whatsapp/chats/send-image", label: "POST /chats/send-image" },
  { group: "Messaging", value: "POST|/api/whatsapp/chats/send-document", label: "POST /chats/send-document" },
  { group: "Messaging", value: "POST|/api/whatsapp/chats/send-audio", label: "POST /chats/send-audio" },
  { group: "Messaging", value: "POST|/api/whatsapp/chats/send-location", label: "POST /chats/send-location" },
  { group: "Messaging", value: "POST|/api/whatsapp/chats/send-contact", label: "POST /chats/send-contact" },
  { group: "Messaging", value: "POST|/api/whatsapp/chats/send-poll", label: "POST /chats/send-poll" },
  { group: "Messaging", value: "POST|/api/whatsapp/chats/presence", label: "POST /chats/presence" },
  { group: "Messaging", value: "POST|/api/whatsapp/chats/check-number", label: "POST /chats/check-number" },
  { group: "Bulk", value: "POST|/api/whatsapp/chats/send-bulk", label: "POST /chats/send-bulk" },
  { group: "Bulk", value: "POST|/api/whatsapp/chats/send-bulk-image", label: "POST /chats/send-bulk-image" },
  { group: "Bulk", value: "POST|/api/whatsapp/chats/send-bulk-document", label: "POST /chats/send-bulk-document" },
  { group: "Bulk", value: "GET|/api/whatsapp/chats/bulk-status/{jobId}", label: "GET /chats/bulk-status/:jobId" },
  { group: "Bulk", value: "POST|/api/whatsapp/chats/bulk-jobs", label: "POST /chats/bulk-jobs - List jobs" },
  { group: "Bulk", value: "POST|/api/whatsapp/chats/bulk-jobs/{jobId}/cancel", label: "POST /chats/bulk-jobs/:jobId/cancel" },
  { group: "Bulk", value: "POST|/api/whatsapp/chats/bulk-jobs/{jobId}/retry", label: "POST /chats/bulk-jobs/:jobId/retry" },
  { group: "History", value: "POST|/api/whatsapp/chats/overview", label: "POST /chats/overview" },
  { group: "History", value: "POST|/api/whatsapp/contacts", label: "POST /contacts" },
  { group: "History", value: "POST|/api/whatsapp/chats/messages", label: "POST /chats/messages" },
  { group: "Groups", value: "POST|/api/whatsapp/groups", label: "POST /groups" },
  { group: "Groups", value: "POST|/api/whatsapp/groups/create", label: "POST /groups/create" },
  { group: "System", value: "GET|/api/websocket/stats", label: "GET /websocket/stats" },
  { group: "System", value: "GET|/api/health", label: "GET /health" },
];

export function sampleBodyFor(path: string, method: string): { body: unknown | null; help: string } {
  if (method === "GET" || path.includes("/health") || path.includes("/websocket/stats")) {
    return { body: null, help: "GET request — no body required." };
  }
  if (path.includes("/send-text")) {
    return {
      body: { sessionId: "", chatId: "628123456789", message: "Hello from WA Gateway!", typingTime: 0, replyTo: null },
      help: "chatId: phone or group ID. typingTime in ms. replyTo is optional.",
    };
  }
  if (path.includes("/send-image")) {
    return {
      body: { sessionId: "", chatId: "628123456789", imageUrl: "https://example.com/image.jpg", caption: "Caption" },
      help: "imageUrl must be a direct URL.",
    };
  }
  if (path.includes("/send-bulk-image")) {
    return {
      body: {
        sessionId: "",
        recipients: ["628123456789", "628987654321"],
        imageUrl: "https://example.com/image.jpg",
        caption: "Caption",
        delayBetweenMessages: 3000,
        delayJitter: 2000,
      },
      help: "Max 100 recipients. Returns a jobId — poll /chats/bulk-status/:jobId.",
    };
  }
  if (path.includes("/send-bulk-document")) {
    return {
      body: {
        sessionId: "",
        recipients: ["628123456789", "628987654321"],
        documentUrl: "https://example.com/document.pdf",
        filename: "document.pdf",
        mimetype: "application/pdf",
        caption: "",
        delayBetweenMessages: 3000,
        delayJitter: 2000,
      },
      help: "Max 100 recipients. Returns a jobId — poll /chats/bulk-status/:jobId.",
    };
  }
  if (path.includes("/send-bulk")) {
    return {
      body: {
        sessionId: "",
        recipients: ["628123456789", "628987654321"],
        message: "Hello from bulk API",
        delayBetweenMessages: 3000,
        delayJitter: 2000,
        typingTime: 0,
      },
      help: "Max 100 recipients. delayBetweenMessages + random 0..delayJitter ms between sends.",
    };
  }
  if (path.includes("/bulk-jobs/") && (path.includes("/cancel") || path.includes("/retry"))) {
    return {
      body: path.includes("/retry") ? { sessionId: "" } : {},
      help: path.includes("/retry")
        ? "Starts a new job for the recipients marked failed/skipped in the source job."
        : "Stops the job after the message currently in flight.",
    };
  }
  if (path.includes("/webhooks") && method === "POST") {
    return {
      body: { url: "https://your-server.com/webhook", events: ["message", "message_ack"] },
      help: "Leave events empty to receive all events.",
    };
  }
  if (path.includes("/connect")) {
    return {
      body: { proxy: "" },
      help: "After connecting, scan the QR code to link WhatsApp. Optional proxy: socks5://user:pass@host:1080 or http://host:8080.",
    };
  }
  if (path.includes("/config")) {
    return {
      body: { proxy: "socks5://user:pass@host:1080", reconnect: true },
      help: "Any of metadata / webhooks / proxy. proxy: URL, or null to remove. A live session reconnects through the new proxy unless reconnect is false.",
    };
  }
  if (path.includes("/proxy/test")) {
    return {
      body: { proxy: "socks5://user:pass@host:1080" },
      help: "Fetches the egress IP through the proxy. Or pass { sessionId } to test that session's configured proxy.",
    };
  }
  return { body: { sessionId: "" }, help: "Fill in the required fields for this endpoint." };
}

function storedApiKey(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("api_key") || "";
}

export function getApiHeaders(includeContentType = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (includeContentType) headers["Content-Type"] = "application/json";
  const key = storedApiKey();
  if (key) headers["X-Api-Key"] = key;
  return headers;
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || "GET").toUpperCase();
  const headers = {
    ...getApiHeaders(method !== "GET"),
    ...(options.headers as Record<string, string> | undefined),
  };
  return fetch(url, { ...options, headers });
}

export async function loginDashboard(username: string, password: string) {
  const response = await fetch("/api/dashboard/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return response.json() as Promise<{ success: boolean; message?: string }>;
}

export async function listSessions() {
  const response = await apiFetch(`${API_BASE}/sessions`);
  return response.json() as Promise<{ success: boolean; message?: string; data: GatewaySession[] }>;
}

export async function connectSession(sessionId: string, body: unknown = {}) {
  const response = await apiFetch(`${API_BASE}/sessions/${sessionId}/connect`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ success: boolean; message?: string }>;
}

export async function deleteSession(sessionId: string) {
  const response = await apiFetch(`${API_BASE}/sessions/${sessionId}`, { method: "DELETE" });
  return response.json() as Promise<{ success: boolean; message?: string }>;
}

export async function getQr(sessionId: string) {
  const response = await apiFetch(`${API_BASE}/sessions/${sessionId}/qr`);
  return response.json() as Promise<{ success: boolean; data?: { qrCode: string; qrExpiresAt?: number } }>;
}

export async function sendText(payload: { sessionId: string; chatId: string; message: string }) {
  const response = await apiFetch(`${API_BASE}/chats/send-text`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return response.json() as Promise<{ success: boolean; message?: string }>;
}

// ---------------------------------------------------------------------------
// Bulk messaging (backend: BulkJobManager — background jobs with history)
// ---------------------------------------------------------------------------

export type BulkJobType = "text" | "image" | "document";
export type BulkJobStatus = "processing" | "completed" | "cancelled" | "interrupted";

export type BulkPayload =
  | { message: string }
  | { imageUrl: string; caption?: string }
  | { documentUrl: string; filename: string; mimetype?: string; caption?: string };

export type BulkOptions = {
  delayBetweenMessages: number;
  delayJitter: number;
  typingTime: number;
};

export type BulkJobDetail = {
  recipient: string;
  status: "sent" | "failed" | "skipped";
  messageId?: string;
  error?: string;
  timestamp: string;
};

/** Row of POST /chats/bulk-jobs — no per-recipient arrays. */
export type BulkJobSummary = {
  jobId: string;
  sessionId: string;
  type: BulkJobType;
  name: string | null;
  status: BulkJobStatus;
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  progress: number;
  cancelRequested: boolean;
  payload: BulkPayload;
  options: BulkOptions;
  createdAt: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
};

/** GET /chats/bulk-status/:jobId — the summary plus every recipient's outcome. */
export type BulkJob = BulkJobSummary & {
  recipients: string[];
  details: BulkJobDetail[];
};

export type StartBulkInput = {
  sessionId: string;
  type: BulkJobType;
  recipients: string[];
  payload: BulkPayload;
  name?: string;
  options?: Partial<BulkOptions>;
};

type BulkStartResponse = {
  success: boolean;
  message?: string;
  data?: { jobId: string; total: number; statusUrl: string; retryOf?: string };
};

const BULK_ENDPOINT: Record<BulkJobType, string> = {
  text: "/chats/send-bulk",
  image: "/chats/send-bulk-image",
  document: "/chats/send-bulk-document",
};

export async function startBulkJob(input: StartBulkInput) {
  const response = await apiFetch(`${API_BASE}${BULK_ENDPOINT[input.type]}`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: input.sessionId,
      recipients: input.recipients,
      name: input.name,
      ...input.payload,
      ...input.options,
    }),
  });
  return response.json() as Promise<BulkStartResponse>;
}

export async function getBulkJob(jobId: string) {
  const response = await apiFetch(`${API_BASE}/chats/bulk-status/${encodeURIComponent(jobId)}`);
  return response.json() as Promise<{ success: boolean; message?: string; data?: BulkJob }>;
}

export async function listBulkJobs(sessionId: string) {
  const response = await apiFetch(`${API_BASE}/chats/bulk-jobs`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  return response.json() as Promise<{ success: boolean; message?: string; data?: BulkJobSummary[] }>;
}

export async function cancelBulkJob(jobId: string) {
  const response = await apiFetch(`${API_BASE}/chats/bulk-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: "{}",
  });
  return response.json() as Promise<{ success: boolean; message?: string; data?: BulkJobSummary }>;
}

export async function retryBulkJob(sessionId: string, jobId: string) {
  const response = await apiFetch(`${API_BASE}/chats/bulk-jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  return response.json() as Promise<BulkStartResponse>;
}

export type SessionConfigPatch = {
  metadata?: Record<string, unknown>;
  webhooks?: GatewaySession["webhooks"];
  /** URL to connect through, or null to remove the proxy. */
  proxy?: string | null;
  /** Default true: a live session is restarted so the new proxy takes effect now. */
  reconnect?: boolean;
};

export async function updateSessionConfig(sessionId: string, patch: SessionConfigPatch) {
  const response = await apiFetch(`${API_BASE}/sessions/${sessionId}/config`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return response.json() as Promise<{
    success: boolean;
    message?: string;
    data?: { sessionId: string; proxy: string | null; proxyApplied: boolean; webhooks: GatewaySession["webhooks"] };
  }>;
}

export type ProxyCheck = {
  ok: boolean;
  ip?: string;
  latencyMs?: number;
  error?: string;
  proxy: string | null;
};

export async function testProxy(body: { proxy?: string; sessionId?: string }) {
  const response = await apiFetch(`${API_BASE}/proxy/test`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ success: boolean; message?: string; data?: ProxyCheck }>;
}

export async function addWebhook(sessionId: string, url: string, events?: string[]) {
  const response = await apiFetch(`${API_BASE}/sessions/${sessionId}/webhooks`, {
    method: "POST",
    body: JSON.stringify({ url, events }),
  });
  return response.json() as Promise<{ success: boolean; data?: { webhooks: GatewaySession["webhooks"] } }>;
}

export async function removeWebhook(sessionId: string, url: string) {
  const encoded = encodeURIComponent(url);
  const response = await apiFetch(`${API_BASE}/sessions/${sessionId}/webhooks?url=${encoded}`, {
    method: "DELETE",
  });
  return response.json() as Promise<{ success: boolean; data?: { webhooks: GatewaySession["webhooks"] } }>;
}

export async function loadWsStats() {
  const response = await fetch("/api/websocket/stats");
  return response.json() as Promise<{ success: boolean; data?: { totalConnections: number } }>;
}

export async function sendRawApi(method: string, path: string, bodyText: string) {
  const options: RequestInit = { method, headers: getApiHeaders(true) };
  if (method === "DELETE" && path.includes("/webhooks") && bodyText) {
    try {
      const obj = JSON.parse(bodyText) as { url?: string };
      if (obj.url) path = `${path}?url=${encodeURIComponent(obj.url)}`;
    } catch {
      /* ignore */
    }
  } else if (method !== "GET" && method !== "DELETE" && bodyText) {
    options.body = bodyText;
  }
  const response = await fetch(path, options);
  return response.json() as Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Real chat history (backend: POST /chats/overview, /chats/messages)
// ---------------------------------------------------------------------------

/** One row of POST /chats/overview. */
export type GatewayChat = {
  id: string;
  name: string | null;
  phone: string | null;
  isGroup: boolean;
  profilePicture: string | null;
  lastMessage: string | null;
  lastMessageTimestamp: number;
  unreadCount: number;
};

/** One row of POST /chats/messages. */
export type GatewayMessage = {
  id: string;
  fromMe: boolean;
  timestamp: number;
  type: string;
  /** Reactions arrive as { emoji, targetMessageId }, not a string. */
  content: string | { emoji?: string; targetMessageId?: string } | null;
  caption: string | null;
  senderName: string | null;
};

export async function listChats(sessionId: string, limit = 50) {
  const response = await apiFetch(`${API_BASE}/chats/overview`, {
    method: "POST",
    body: JSON.stringify({ sessionId, limit, offset: 0, type: "all" }),
  });
  return response.json() as Promise<{
    success: boolean;
    message?: string;
    data?: { total: number; hasMore: boolean; chats: GatewayChat[] };
  }>;
}

export async function listMessages(sessionId: string, chatId: string, limit = 50) {
  const response = await apiFetch(`${API_BASE}/chats/messages`, {
    method: "POST",
    body: JSON.stringify({ sessionId, chatId, limit }),
  });
  return response.json() as Promise<{
    success: boolean;
    message?: string;
    data?: { chatId: string; messages: GatewayMessage[] };
  }>;
}
