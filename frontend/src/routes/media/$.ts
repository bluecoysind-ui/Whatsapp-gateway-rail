import { createFileRoute } from "@tanstack/react-router";
import { forwardToGateway } from "@/lib/gateway-proxy.server";

/**
 * Saved media (/media/<session>/<chat>/<file>) is served by the gateway. In
 * production the backend hosts this SPA so the path resolves directly; this
 * route keeps it working in the standalone dev server too.
 */
export const Route = createFileRoute("/media/$")({
  server: {
    handlers: {
      GET: ({ request, params }) => forwardToGateway(request, `/media/${params._splat ?? ""}`),
    },
  },
});
