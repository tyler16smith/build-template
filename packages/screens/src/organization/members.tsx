import {
  assignableRoles,
  invitableRoles,
  isOwnerRole,
  mayChangeMember,
  type Invite,
  type InviteRole,
  type Member,
  type Role,
} from "@template/contracts";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogContent,
  DialogFooter,
  ErrorState,
  Field,
  formatRelative,
  Input,
  Select,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  toast,
  TR,
} from "@template/ui";
import { useState } from "react";
import { FormError } from "../auth/layout";
import { useAssistantPageContext } from "../assistant/assistant";
import { ORGANIZATION_NOUN } from "../brand";
import { errorMessage, useApi, useCan, useNav, useSession, useSubmit } from "../context";
import { SettingsLayout } from "../settings/layout";
import { useLoad } from "../use-load";
import { ROLE_IN_A_SENTENCE, ROLE_LABELS } from "./roles";

/**
 * `/settings/members`: everyone in the company, their roles, and pending invitations. Every
 * member sees the list; changing roles, removing people and inviting need `members.manage`
 * (what each person may change follows `mayChangeMember`). Role changes save as they're picked,
 * with Undo.
 */
export function MembersScreen() {
  const api = useApi();
  const { session } = useSession();
  const canManage = useCan("members.manage");
  const organization = session?.profile?.organization;
  // Two loads, so they run side by side. Invites that fail to load show as none.
  const members = useLoad(() => api.members.list().then((result) => result.members), "members");
  const invites = useLoad(
    canManage
      ? () =>
          api.invites
            .list()
            .then((result) => result.invites)
            .catch((): Invite[] => [])
      : null,
    "invites",
  );
  const reload = () => {
    void members.refetch();
    void invites.refetch();
  };
  useAssistantPageContext({
    title: "Members",
    summary: `The ${ORGANIZATION_NOUN.one}'s members and their roles${canManage ? ", and pending invitations" : ""}.`,
    suggestions: canManage
      ? ["Who are the admins?", "Invite someone as a member", "Which invitations expired?"]
      : ["Who are the admins?", "Who's on the team?"],
  });
  if (!organization) return null;
  return (
    <SettingsLayout
      description={`Everyone in ${organization.name}.`}
      actions={canManage ? <InviteButton onSent={reload} /> : null}
    >
      {members.error ? (
        <ErrorState
          title="Couldn't load the members"
          error={new Error(errorMessage(members.error))}
          onRetry={reload}
        />
      ) : (
        <MembersTable members={members.data} onChanged={reload} />
      )}
      {canManage ? <InvitesCard invites={invites.data} onChanged={reload} /> : null}
    </SettingsLayout>
  );
}

function MembersTable({ members, onChanged }: { members: Member[] | null; onChanged: () => void }) {
  const api = useApi();
  const { session, refresh } = useSession();
  const profile = session!.profile!;
  const actor = { userId: profile.id, role: profile.role! };
  const [removing, setRemoving] = useState<Member | null>(null);
  const [leaving, setLeaving] = useState(false);

  const changeRole = async (member: Member, role: Role) => {
    try {
      await api.members.updateRole({ userId: member.userId, role });
      onChanged();
      if (member.you) await refresh();
      toast(`${member.name} is ${ROLE_IN_A_SENTENCE[role]} now`, {
        tone: "success",
        actions: [
          {
            label: "Undo",
            onClick: () =>
              void api.members
                .updateRole({ userId: member.userId, role: member.role })
                .then(async () => {
                  onChanged();
                  if (member.you) await refresh();
                })
                .catch((failure: unknown) =>
                  toast("Couldn't undo", { description: errorMessage(failure), tone: "danger" }),
                ),
          },
        ],
      });
    } catch (failure) {
      toast(`Couldn't change ${member.name}'s role`, {
        description: errorMessage(failure),
        tone: "danger",
      });
    }
  };

  if (!members)
    return (
      <Card>
        <CardBody className="grid gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </CardBody>
      </Card>
    );
  return (
    <Card>
      <Table>
        <THead>
          <TR>
            <TH>Name</TH>
            <TH className="hidden md:table-cell">Email</TH>
            <TH className="hidden lg:table-cell">Job title</TH>
            <TH>Role</TH>
            <TH className="w-0">
              <span className="sr-only">Actions</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {members.map((member) => {
            const roles = assignableRoles(actor, member);
            const removable =
              !member.you && !mayChangeMember({ actor, target: member, newRole: null });
            return (
              <TR key={member.userId}>
                <TD>
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar name={member.name} size="sm" />
                    <span className="truncate font-medium text-foreground">{member.name}</span>
                    {member.you ? <Badge tone="accent">You</Badge> : null}
                  </div>
                </TD>
                <TD className="hidden text-muted-foreground md:table-cell">{member.email}</TD>
                <TD className="hidden text-muted-foreground lg:table-cell">{member.title ?? ""}</TD>
                <TD>
                  {roles.length > 1 ? (
                    <Select
                      aria-label={`${member.name}'s role`}
                      value={member.role}
                      onValueChange={(next) => {
                        if (next !== member.role) void changeRole(member, next as Role);
                      }}
                      options={roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
                      className="w-32"
                    />
                  ) : (
                    <Badge tone={isOwnerRole(member.role) ? "accent" : "neutral"}>
                      {ROLE_LABELS[member.role]}
                    </Badge>
                  )}
                </TD>
                <TD className="text-right">
                  {member.you ? (
                    <Button variant="ghost" size="sm" onClick={() => setLeaving(true)}>
                      Leave
                    </Button>
                  ) : removable ? (
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(member)}>
                      Remove
                    </Button>
                  ) : null}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <RemoveDialog
        member={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          onChanged();
        }}
      />
      <LeaveDialog open={leaving} members={members} onClose={() => setLeaving(false)} />
    </Card>
  );
}

function RemoveDialog({
  member,
  onClose,
  onRemoved,
}: {
  member: Member | null;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const api = useApi();
  const { session } = useSession();
  const remove = useSubmit(async () => {
    if (!member) return;
    await api.members.remove({ userId: member.userId });
    toast(`${member.name} was removed`, { tone: "success" });
    onRemoved();
  });
  return (
    <Dialog open={member !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        title={`Remove ${member?.name ?? "them"}?`}
        description={`They lose access to ${session?.profile?.organization?.name ?? `the ${ORGANIZATION_NOUN.one}`} at once, and their connected apps for it are disconnected. You can invite them again.`}
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void remove.run();
          }}
        >
          <FormError message={remove.error} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" submitShortcut loading={remove.pending}>
              Remove
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LeaveDialog({
  open,
  members,
  onClose,
}: {
  open: boolean;
  members: Member[];
  onClose: () => void;
}) {
  const api = useApi();
  const nav = useNav();
  const { session, refresh } = useSession();
  const name = session?.profile?.organization?.name ?? `this ${ORGANIZATION_NOUN.one}`;
  const me = members.find((m) => m.you);
  const lastOwner =
    Boolean(me && isOwnerRole(me.role)) && members.filter((m) => isOwnerRole(m.role)).length <= 1;
  const leave = useSubmit(async () => {
    const { next } = await api.organization.leave();
    await refresh();
    toast(`You left ${name}`, { tone: "success" });
    nav.navigate(next ? "/" : "/onboarding", { replace: true });
  });
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent title={`Leave ${name}?`} description="Someone can invite you back later.">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!lastOwner) void leave.run();
          }}
        >
          {lastOwner ? (
            <Alert tone="warning">
              {name} needs at least one owner. Make someone else an owner first.
            </Alert>
          ) : (
            <Alert tone="warning">You're about to lose access to {name}.</Alert>
          )}
          <FormError message={leave.error} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              submitShortcut
              loading={leave.pending}
              disabled={lastOwner}
            >
              Leave
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InviteButton({ onSent }: { onSent: () => void }) {
  const api = useApi();
  const { session } = useSession();
  const roles = invitableRoles(session!.profile!.role!);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const send = useSubmit(async () => {
    const sent = await api.invites.create({ email, role });
    toast(sent.resent ? "Invitation sent again" : "Invitation sent", {
      description: `We emailed ${sent.email} a link that works for 7 days.`,
      tone: "success",
    });
    setOpen(false);
    setEmail("");
    setRole("member");
    onSent();
  });
  return (
    <>
      <Button onClick={() => setOpen(true)}>Invite member</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Invite member"
          description={`They get an email with a link to join ${session?.profile?.organization?.name ?? `the ${ORGANIZATION_NOUN.one}`}.`}
        >
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void send.run();
            }}
          >
            <FormError message={send.error} />
            <Field label="Email" error={send.fields.email}>
              <Input
                type="email"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
            </Field>
            <Field
              label="Role"
              hint="Admins can invite people and change members. Members use the app."
              error={send.fields.role}
            >
              <Select
                value={role}
                onValueChange={(next) => setRole(next as InviteRole)}
                options={roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={send.pending}>
                Send invite
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InvitesCard({ invites, onChanged }: { invites: Invite[] | null; onChanged: () => void }) {
  const api = useApi();
  const [revoking, setRevoking] = useState<Invite | null>(null);
  const resend = useSubmit(async (invite: Invite) => {
    await api.invites.resend({ inviteId: invite.id });
    toast("Invitation sent again", {
      description: `The old link to ${invite.email} no longer works.`,
      tone: "success",
    });
    onChanged();
  });
  const revoke = useSubmit(async () => {
    if (!revoking) return;
    await api.invites.revoke({ inviteId: revoking.id });
    toast("Invitation revoked", { tone: "success" });
    setRevoking(null);
    onChanged();
  });
  return (
    <Card>
      <CardHeader
        title="Pending invitations"
        description="Links work for 7 days. Sending one again makes a new link."
      />
      <CardBody className="grid gap-3">
        <FormError message={resend.error} />
        {!invites ? <Skeleton className="h-10" /> : null}
        {invites && !invites.length ? (
          <p className="text-sm text-muted-foreground">No pending invitations.</p>
        ) : null}
        {invites?.length ? (
          <ul className="divide-y divide-border">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-foreground">{invite.email}</span>
                    <Badge tone="neutral">{ROLE_LABELS[invite.role]}</Badge>
                    {invite.expired ? <Badge tone="warning">Expired</Badge> : null}
                  </p>
                  <p className="text-muted-foreground">
                    Invited by {invite.invitedBy.name ?? "a former member"} ·{" "}
                    {invite.expired
                      ? `expired ${formatRelative(new Date(invite.expiresAt))}`
                      : `expires ${formatRelative(new Date(invite.expiresAt))}`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  loading={resend.pending}
                  onClick={() => void resend.run(invite)}
                >
                  Resend
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRevoking(invite)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </CardBody>
      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => (!open ? setRevoking(null) : undefined)}
      >
        <DialogContent
          title="Revoke this invitation?"
          description={`The link sent to ${revoking?.email ?? "them"} stops working.`}
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void revoke.run();
            }}
          >
            <FormError message={revoke.error} />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setRevoking(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" submitShortcut loading={revoke.pending}>
                Revoke
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
