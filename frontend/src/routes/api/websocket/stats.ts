import { createFileRoute } from "@tanstack/react-router";
import { forwardToGateway } from "@/lib/gateway-proxy.server";

export const Route = createFileRoute("/api/websocket/stats")({
  server: {
    handlers: {
      GET: ({ request }) => forwardToGateway(request, "/api/websocket/stats"),
    },
  },
});
