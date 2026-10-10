import {
  ZAPIER_SECRET_HEADER,
  type AutomationDefinition,
  type ZapierConnectionView,
} from "@template/contracts";

/**
 * The exact Zap to build, for the Automation Builder's `zapier_setup` tool and the connection
 * page. It never includes a secret: the person copies the inbound secret from where it was shown
 * once, and the outbound hook URL comes from Zapier itself.
 */
export type ZapierSetup =
  | {
      direction: "inbound";
      connection: { id: string; name: string } | null;
      steps: string[];
      url: string | null;
      header: string;
      body: Record<string, unknown>;
    }
  | {
      direction: "outbound";
      connection: { id: string; name: string } | null;
      steps: string[];
      samplePayload: Record<string, unknown>;
    };

/** `{{trigger.data.dealName}}` → `dealName`: the fields the automation reads from the event. */
function dataFields(definition: AutomationDefinition): string[] {
  const text = JSON.stringify(definition.steps);
  return [
    ...new Set([...text.matchAll(/trigger\.data\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!)),
  ];
}

export function inboundSetup(
  definition: AutomationDefinition,
  connection: ZapierConnectionView | null,
  sourceApp: string,
): ZapierSetup {
  const trigger = definition.trigger.kind === "zapier.event" ? definition.trigger : null;
  const fields = dataFields(definition);
  const body = {
    provider: trigger?.provider || sourceApp.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    eventType: trigger?.eventType || "event.happened",
    externalId: "{{the record's id in Zapier}}",
    data: Object.fromEntries(
      (fields.length ? fields : ["name"]).map((field) => [field, `{{${field} from the trigger}}`]),
    ),
  };
  return {
    direction: "inbound",
    connection: connection ? { id: connection.id, name: connection.name } : null,
    url: connection?.url ?? null,
    header: ZAPIER_SECRET_HEADER,
    body,
    steps: [
      connection
        ? `Use the Zapier connection “${connection.name}” (Connections → Zapier).`
        : "Create an inbound Zapier connection first (Connections → Zapier) and copy its secret.",
      `In Zapier, create a Zap. Trigger: ${sourceApp}, with the event you want.`,
      "Action: Webhooks by Zapier → POST.",
      `URL: ${connection?.url ?? "the connection's URL"}. Payload Type: json.`,
      `Headers: ${ZAPIER_SECRET_HEADER} = the connection's secret.`,
      `Data: the fields below, each mapped to the ${sourceApp} field it names.`,
      "Test the step in Zapier, then turn the Zap on. The setup is done once the first event arrives here.",
    ],
  };
}

export function outboundSetup(
  definition: AutomationDefinition,
  connection: ZapierConnectionView | null,
  destinationApp: string,
): ZapierSetup {
  const step = JSON.stringify(definition.steps);
  const body = /"kind":"zapier\.send"[^}]*"body":(\{[^}]*\})/.exec(step)?.[1];
  let samplePayload: Record<string, unknown> = { example: "value" };
  try {
    if (body) samplePayload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // The sample stays generic.
  }
  return {
    direction: "outbound",
    connection: connection ? { id: connection.id, name: connection.name } : null,
    samplePayload,
    steps: [
      "In Zapier, create a Zap. Trigger: Webhooks by Zapier → Catch Hook. Copy its URL.",
      connection
        ? `Paste it into the Zapier hook “${connection.name}” (Connections → Zapier) if it changed.`
        : "Add it here as an outbound Zapier hook (Connections → Zapier → Add an outbound hook).",
      "Send a test from the automation (or the hook's Send test button) so Zapier sees the fields below.",
      `Action: ${destinationApp}, mapping each field from the Catch Hook.`,
      "Turn the Zap on. The setup is done once a test send arrives in Zapier.",
    ],
  };
}
