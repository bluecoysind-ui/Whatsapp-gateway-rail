import { createFileRoute } from "@tanstack/react-router";
import { GatewayApp } from "@/components/gateway/GatewayApp";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <GatewayApp />;
}
