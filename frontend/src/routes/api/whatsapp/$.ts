import { createFileRoute } from "@tanstack/react-router";
import { forwardToGateway } from "@/lib/gateway-proxy.server";

/** Every /api/whatsapp/* call goes to the real gateway (was a demo stub). */
export const Route = createFileRoute("/api/whatsapp/$")({
  server: {
    handlers: {
      GET: ({ request, params }) => proxy(request, params._splat),
      POST: ({ request, params }) => proxy(request, params._splat),
      PATCH: ({ request, params }) => proxy(request, params._splat),
      DELETE: ({ request, params }) => proxy(request, params._splat),
    },
  },
});

function proxy(request: Request, splat: string | undefined) {
  return forwardToGateway(request, `/api/whatsapp/${splat ?? ""}`);
}
