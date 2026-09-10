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
  { group: "Bulk", value: "GET|/api/whatsapp/chats/bulk-status/{jobId}", label: "GET /chats/bulk-status/:jobId" },
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
  if (path.includes("/send-bulk") && !path.includes("image") && !path.includes("document")) {
    return {
      body: { sessionId: "", recipients: ["628123456789", "628987654321"], message: "Hello from bulk API", delay: 1000 },
      help: "Max 100 recipients. delay is milliseconds between sends.",
    };
  }
  if (path.includes("/webhooks") && method === "POST") {
    return {
      body: { url: "https://your-server.com/webhook", events: ["message", "message_ack"] },
      help: "Leave events empty to receive all events.",
    };
  }
  if (path.includes("/connect")) {
    return { body: {}, help: "After connecting, scan the QR code to link WhatsApp." };
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

export async function sendBulk(payload: { sessionId: string; recipients: string[]; message: string; delay?: number }) {
  const response = await apiFetch(`${API_BASE}/chats/send-bulk`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return response.json() as Promise<{ success: boolean; message?: string; data?: { jobId: string } }>;
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
