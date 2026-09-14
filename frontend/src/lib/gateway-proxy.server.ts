/**
 * Server-side reverse proxy to the real Chatery WhatsApp backend.
 *
 * The app's `/api/*` routes used to answer from `demo-data.ts`, so the UI
 * looked healthy while nothing reached WhatsApp. These handlers forward to the
 * Express gateway instead, which means a failed send now actually reports as
 * failed.
 *
 * Override the target with WA_GATEWAY_URL when the backend is not on :3001.
 */

export const GATEWAY_ORIGIN = (
  process.env.WA_GATEWAY_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

/**
 * Pipe one request through to the gateway, preserving method, query, body and
 * the response's own status and content type.
 *
 * The body is copied as bytes rather than re-serialized JSON so that
 * `/qr/image` (image/png) survives the round trip alongside the JSON routes.
 */
export async function forwardToGateway(request: Request, path: string): Promise<Response> {
  const search = new URL(request.url).search;
  const target = `${GATEWAY_ORIGIN}${path}${search}`;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  // Forwarded so the proxy keeps working if API_KEY is re-enabled on the backend.
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) headers.set("x-api-key", apiKey);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      // An empty buffer would still send `content-length: 0`, which Express 5
      // leaves as an undefined `req.body` — the gateway handles that.
      body: hasBody && body && body.byteLength > 0 ? body : undefined,
    });
  } catch (error) {
    // Surface the outage instead of falling back to fake success.
    return Response.json(
      {
        success: false,
        message: `Gateway unreachable at ${GATEWAY_ORIGIN} — is the backend running? (${
          error instanceof Error ? error.message : String(error)
        })`,
      },
      { status: 502 },
    );
  }

  const payload = await upstream.arrayBuffer();
  return new Response(payload, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}
