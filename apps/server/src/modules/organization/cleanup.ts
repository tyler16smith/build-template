import { aiConversations, automations, memberships, type Database } from "@template/db";
import { getAgentByName } from "agents";
import type { Env } from "../../env";
import { conversationName } from "../assistant/conversations";

type Destroyable = { destroyConversation(): Promise<void> };

/**
 * Before a deleted organization's rows go for good (`Organizations.purgeDeleted`): every
 * Assistant conversation and Automation Builder chat in it loses its Durable Object storage, so
 * nothing of the organization survives outside Postgres either.
 */
export async function purgeOrganizationAgents(
  env: Env,
  database: Database,
  organizationId: string,
): Promise<{ conversations: number; builders: number }> {
  const db = database.tenant(
    { organizationId, userId: "" },
    { label: "organization.purge.agents" },
  );
  const [conversations, members, flows] = await db.batch((q) => [
    q.select(aiConversations),
    q.select(memberships),
    q.select(automations),
  ]);
  for (const row of conversations) {
    const agent = (await getAgentByName(
      env.AssistantAgent as never,
      conversationName(organizationId, row.userId, row.id),
    )) as unknown as Destroyable;
    await agent.destroyConversation();
  }
  // The builder's chat is per person per automation: anyone who could open it.
  let builders = 0;
  for (const automation of flows)
    for (const member of members) {
      const agent = (await getAgentByName(
        env.AutomationAgent as never,
        conversationName(organizationId, member.userId, automation.id),
      )) as unknown as Destroyable;
      await agent.destroyConversation();
      builders++;
    }
  return { conversations: conversations.length, builders };
}
