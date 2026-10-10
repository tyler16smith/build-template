import { AI_LIMITS, type AiConversation } from "@template/contracts";
import {
  aiConversations,
  and,
  desc,
  eq,
  NO_ORGANIZATION,
  type Database,
  type TenantDb,
} from "@template/db";
import { getAgentByName } from "agents";
import type { Env } from "../../env";

/**
 * The conversation index: one row per Assistant conversation, for the panel's list. The messages
 * themselves live in the conversation's Durable Object, named `<organization>:<user>:<id>`.
 */
export function conversationName(organizationId: string, userId: string, conversation: string) {
  return `${organizationId}:${userId}:${conversation}`;
}

export function parseConversationName(name: string): {
  organizationId: string;
  userId: string;
  conversation: string;
} {
  const [organizationId, userId, conversation] = name.split(":");
  if (!organizationId || !userId || !conversation) throw new Error(`Malformed agent name ${name}`);
  return { organizationId, userId, conversation };
}

/** Upserts the index row after a turn; the title is the first thing the person said. */
export async function touchConversation(
  db: TenantDb,
  input: { userId: string; id: string; title: string | null },
): Promise<void> {
  const now = new Date();
  await db.one((q) =>
    q.drizzle
      .insert(aiConversations)
      .values({
        organizationId: q.organizationId,
        userId: input.userId,
        id: input.id,
        title: input.title,
        lastMessageAt: now,
      })
      .onConflictDoUpdate({
        target: [aiConversations.organizationId, aiConversations.userId, aiConversations.id],
        set: { lastMessageAt: now, ...(input.title ? { title: input.title } : {}) },
      }),
  );
}

export async function listConversations(db: TenantDb): Promise<AiConversation[]> {
  const rows = await db.one((q) =>
    q.select(aiConversations, {
      where: eq(aiConversations.userId, db.userId),
      orderBy: [desc(aiConversations.lastMessageAt)],
      limit: AI_LIMITS.conversationsListed,
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.lastMessageAt.toISOString(),
  }));
}

type Destroyable = { destroyConversation(): Promise<void> };

/** Deletes a conversation's messages (its Durable Object's storage), then its index row. */
export async function deleteConversation(env: Env, db: TenantDb, id: string): Promise<void> {
  const agent = (await getAgentByName(
    env.AssistantAgent as never,
    conversationName(db.organizationId, db.userId, id),
  )) as unknown as Destroyable;
  await agent.destroyConversation();
  await db.one((q) =>
    q.delete(
      aiConversations,
      and(eq(aiConversations.userId, db.userId), eq(aiConversations.id, id)),
    ),
  );
}

/**
 * Account deletion: every conversation the person had, in every organization, loses its
 * messages before the person's rows go (`Accounts.purgeDeletedAccounts`'s `beforeRemove`).
 * Listing across organizations uses the `own_conversations` policy.
 */
export async function purgeConversationsOf(env: Env, database: Database, userId: string) {
  const rows = await database.one(
    (d) =>
      d
        .select({ organizationId: aiConversations.organizationId, id: aiConversations.id })
        .from(aiConversations)
        .where(eq(aiConversations.userId, userId)),
    { "app.organization_id": NO_ORGANIZATION, "app.user_id": userId, "app.job": "account-cleanup" },
    { name: "assistant.conversations.purge" },
  );
  for (const row of rows)
    await deleteConversation(
      env,
      database.tenant({ organizationId: row.organizationId, userId }),
      row.id,
    );
  return rows.length;
}
