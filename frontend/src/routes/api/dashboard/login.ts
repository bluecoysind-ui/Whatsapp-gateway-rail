import { createFileRoute } from "@tanstack/react-router";
import { forwardToGateway } from "@/lib/gateway-proxy.server";

/** Real credential check against DASHBOARD_USERNAME/PASSWORD on the gateway. */
export const Route = createFileRoute("/api/dashboard/login")({
  server: {
    handlers: {
      POST: ({ request }) => forwardToGateway(request, "/api/dashboard/login"),
    },
  },
});
