import type { AgentConnection } from "@template/api-client";
import type { AgentKind } from "@template/contracts";
import { useEffect, useState } from "react";
import { useApi } from "../context";

/**
 * An open connection to an agent for as long as the component is mounted. Screens never open
 * sockets themselves: the API client's `connectAgent` does (the web app's is the Agents SDK
 * client, same origin). Null until it's open, and while it switches to another name.
 */
export function useAgentConnection(kind: AgentKind, name: string | null): AgentConnection | null {
  const api = useApi();
  const [open, setOpen] = useState<{ name: string; connection: AgentConnection } | null>(null);
  useEffect(() => {
    if (!name) return;
    const connection = api.connectAgent(kind, name);
    setOpen({ name, connection });
    return () => {
      connection.close();
      setOpen(null);
    };
  }, [api, kind, name]);
  return open?.name === name ? open.connection : null;
}
