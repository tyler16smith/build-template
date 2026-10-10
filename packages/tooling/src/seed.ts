import { hashPassword } from "@template/auth";
import {
  eq,
  environmentMarkers,
  memberships,
  organizationInvites,
  organizations,
  setContext,
  users,
  type Database,
  type MembershipRole,
} from "@template/db";
import { DEMO_MARKER } from "./db";
import { automationRows } from "./seed-automations";
import type { Env } from "./shared";

/**
 * The demo data (SPEC.md, "Demo data"): Three Pigs Construction and its three projects (Straw MVP,
 * Stick Upgrade, Brick Production), a small demolition company so isolation is visible on staging,
 * and Huff & Puff Testing, so Wolfgang (in all three) shows the switcher.
 * Every row has a fixed id and is upserted, so the seed runs on every staging deploy, restores
 * whatever a click-through changed, and touches no other rows. Every module adds its demo rows
 * here, in the same voice, in the PR that adds its tables.
 */
export type DemoPerson = {
  id: string;
  email: string;
  name: string;
  title: string;
  role: MembershipRole;
};
export type DemoInvite = {
  id: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string;
  sendCount: number;
  /** Hours from now: negative is already expired. */
  expiresInHours: number;
};
export type DemoOrganization = {
  id: string;
  name: string;
  slug: string;
  people: DemoPerson[];
  invites?: DemoInvite[];
};

const id = (n: number) => `0199d5a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

/** Stress tests for two companies on staging, and the only owner of a third. */
const WOLF = {
  id: id(301),
  email: "wolf@huffandpuff.example",
  name: "Wolfgang Huffington",
  title: "Stress testing, all three projects. Huffs, puffs, files the report",
};

export const DEMO: DemoOrganization[] = [
  {
    id: id(1),
    name: "Three Pigs Construction",
    slug: "three-pigs-construction",
    people: [
      {
        id: id(101),
        email: "bea@threepigs.example",
        name: "Bea Brickley",
        role: "owner",
        title: "Founder. Lead on Brick Production. Measures twice, mortars once",
      },
      {
        id: id(102),
        email: "hank@threepigs.example",
        name: "Hank Hayes",
        role: "admin",
        title: "Lead on Straw MVP. Shipped it in an afternoon. It shows",
      },
      {
        id: id(103),
        email: "stu@threepigs.example",
        name: "Stu Sticksworth",
        role: "member",
        title: 'Lead on Stick Upgrade. "Twigs are just lightweight lumber"',
      },
      {
        id: id(104),
        email: "mort@threepigs.example",
        name: "Mortimer Trowel",
        role: "member",
        title: "Masonry, Brick Production. Has opinions about grout",
      },
      {
        id: id(105),
        email: "clem@threepigs.example",
        name: "Clem Chimney",
        role: "member",
        title: "Chimneys and flues. Keeps a pot boiling at the bottom, just in case",
      },
      {
        id: id(106),
        email: "polly@threepigs.example",
        name: "Polly Planks",
        role: "member",
        title: "Carpentry, Stick Upgrade. Quietly adding nails",
      },
      {
        id: id(107),
        email: "sid@threepigs.example",
        name: "Sid Sparks",
        role: "member",
        title: "Electrical. Wired the straw house. Regrets it",
      },
      { ...WOLF, role: "member" },
    ],
    invites: [
      {
        id: id(1001),
        email: "mama@threepigs.example",
        role: "admin",
        invitedBy: id(101),
        sendCount: 3,
        expiresInHours: 48,
      },
      {
        id: id(1002),
        email: "goldilocks@threebears.example",
        role: "member",
        invitedBy: id(102),
        sendCount: 1,
        expiresInHours: -72,
      },
    ],
  },
  {
    id: id(2),
    name: "Big Bad Demolition Co.",
    slug: "big-bad-demolition-co",
    people: [
      {
        id: id(201),
        email: "rex@bigbad.example",
        name: "Rex Howler",
        role: "owner",
        title: "Owner. Demolition by appointment, or by lung",
      },
      {
        id: id(202),
        email: "rita@bigbad.example",
        name: "Rita Redhood",
        role: "member",
        title: "Site safety. Keeps asking why the foreman's teeth are so big",
      },
      { ...WOLF, role: "admin" },
    ],
  },
  {
    id: id(3),
    name: "Huff & Puff Testing",
    slug: "huff-and-puff-testing",
    // Wolfgang is its only owner, so deleting his account is refused (the last-owner rule).
    people: [{ ...WOLF, role: "owner" }],
  },
];

export async function seedDemo(
  database: Database,
  env: Env,
  password: string,
): Promise<{ people: number }> {
  if (env === "production") throw new Error("The demo seed never runs on production.");
  if (!password || password.length < 10)
    throw new Error(
      "Set the demo password (DEMO_PASSWORD; STAGING_DEMO_PASSWORD in CI), at least 10 characters.",
    );
  const markers = await database.one((d) =>
    d.select().from(environmentMarkers).where(eq(environmentMarkers.name, DEMO_MARKER)),
  );
  if (!markers.length)
    throw new Error(
      `This database has no ${DEMO_MARKER} marker, so it isn't one demo data may go into. If it's local or staging, run pnpm db:allow-demo --env ${env} once.`,
    );
  const passwordHash = await hashPassword(password);
  const now = new Date();
  let people = 0;
  for (const organization of DEMO) {
    await database.batch(
      (d) => [
        ...organization.people.map((person) =>
          d
            .insert(users)
            .values({ ...person, passwordHash, emailVerifiedAt: now })
            .onConflictDoUpdate({
              target: users.id,
              set: {
                email: person.email,
                name: person.name,
                title: person.title,
                passwordHash,
                emailVerifiedAt: now,
                deletedAt: null,
                updatedAt: now,
              },
            }),
        ),
        setContext(d, { organizationId: organization.id }),
        d
          .insert(organizations)
          .values({
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            createdByUserId: organization.people.find((p) => p.role === "owner")?.id ?? null,
          })
          .onConflictDoUpdate({
            target: organizations.id,
            set: { name: organization.name, slug: organization.slug, deletedAt: null },
          }),
        ...organization.people.map((person) =>
          d
            .insert(memberships)
            .values({ organizationId: organization.id, userId: person.id, role: person.role })
            .onConflictDoUpdate({
              target: [memberships.organizationId, memberships.userId],
              set: { role: person.role },
            }),
        ),
        ...(organization.invites ?? []).map((invite) => {
          const values = {
            role: invite.role,
            // Nobody holds a token for a demo invite: its link is never sent.
            tokenHash: `demo:${invite.id}`,
            invitedByUserId: invite.invitedBy,
            expiresAt: new Date(now.getTime() + invite.expiresInHours * 3_600_000),
            lastSentAt: new Date(now.getTime() + (invite.expiresInHours - 7 * 24) * 3_600_000),
            sendCount: invite.sendCount,
            acceptedAt: null,
            acceptedByUserId: null,
          };
          return d
            .insert(organizationInvites)
            .values({
              organizationId: organization.id,
              id: invite.id,
              email: invite.email,
              ...values,
            })
            .onConflictDoUpdate({
              target: [organizationInvites.organizationId, organizationInvites.id],
              set: values,
            });
        }),
        // Automations, past runs and the Zapier connection (`seed-automations.ts`).
        ...automationRows(d, organization.id, now),
      ],
      { "app.organization_id": organization.id },
      { name: "seed" },
    );
    people += organization.people.length;
  }
  return { people };
}
