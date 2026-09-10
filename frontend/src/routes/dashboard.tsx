import { createFileRoute } from "@tanstack/react-router";
import { GatewayApp } from "@/components/gateway/GatewayApp";

/**
 * The app is served from the Express backend at /dashboard, so it needs a route
 * at that path — a router `basepath` did not survive the SPA shell hydration.
 */
export const Route = createFileRoute("/dashboard")({ component: GatewayApp });
