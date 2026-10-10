import { isOwnerRole, type Member } from "@template/contracts";
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Select,
  toast,
} from "@template/ui";
import { useEffect, useState, type FormEvent } from "react";
import { FormError } from "../auth/layout";
import { useAssistantPageContext } from "../assistant/assistant";
import { ORGANIZATION_NOUN, organizationLabel } from "../brand";
import { useApi, useCan, useNav, useSession, useSubmit } from "../context";
import { SettingsLayout } from "../settings/layout";
import { useLoad } from "../use-load";

/** The organization's members, for the owner and leave checks on this page. */
function useMembers() {
  const api = useApi();
  const { data, refetch } = useLoad(
    () =>
      api.members
        .list()
        .then((result) => result.members)
        .catch((): Member[] => []),
    "members",
  );
  return { members: data, reload: () => void refetch() };
}

/**
 * `/settings/organization`: the company's name and slug, leaving it, transferring ownership and
 * deleting it. Every member sees it; what they can change follows their permissions.
 */
export function OrganizationSettingsScreen() {
  const { session } = useSession();
  const { members, reload } = useMembers();
  const organization = session?.profile?.organization;
  useAssistantPageContext({
    title: `${organizationLabel()} settings`,
    summary: `The ${ORGANIZATION_NOUN.one}'s name and slug, leaving it, ownership and deletion.`,
    suggestions: [`Rename the ${ORGANIZATION_NOUN.one}`, "Who are the owners?"],
  });
  if (!organization) return null;
  return (
    <SettingsLayout
      description={`Settings for ${organization.name}. Everything in it belongs to the ${ORGANIZATION_NOUN.one}, not to any one person.`}
    >
      <GeneralCard />
      <TransferCard members={members} onDone={reload} />
      <LeaveCard members={members} />
      <DeleteCard />
    </SettingsLayout>
  );
}

function GeneralCard() {
  const { session, refresh } = useSession();
  const api = useApi();
  const canManage = useCan("organization.manage");
  const organization = session!.profile!.organization!;
  const [name, setName] = useState(organization.name);
  const [slug, setSlug] = useState(organization.slug ?? "");
  useEffect(() => {
    setName(organization.name);
    setSlug(organization.slug ?? "");
  }, [organization.name, organization.slug]);
  const changed = name.trim() !== organization.name || slug.trim() !== (organization.slug ?? "");
  const save = useSubmit(async () => {
    await api.organization.update({
      ...(name.trim() !== organization.name ? { name } : {}),
      ...(slug.trim() !== (organization.slug ?? "") ? { slug } : {}),
    });
    await refresh();
    toast(`${organizationLabel()} saved`, { tone: "success" });
  });
  return (
    <Card>
      <CardHeader
        title="General"
        description={
          canManage
            ? undefined
            : `Only owners and admins can change the ${ORGANIZATION_NOUN.one}'s details.`
        }
      />
      <CardBody>
        <form
          className="grid gap-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (canManage) void save.run();
          }}
        >
          <FormError message={save.error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`${organizationLabel()} name`} error={save.fields.name}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                readOnly={!canManage}
                autoComplete="organization"
              />
            </Field>
            <Field
              label="Slug"
              hint="Used in links later. Lowercase letters, numbers and hyphens."
              error={save.fields.slug}
            >
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                readOnly={!canManage}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          {canManage ? (
            <Button
              type="submit"
              loading={save.pending}
              disabled={!changed}
              className="justify-self-start"
            >
              Save
            </Button>
          ) : null}
        </form>
      </CardBody>
    </Card>
  );
}

function TransferCard({ members, onDone }: { members: Member[] | null; onDone: () => void }) {
  const api = useApi();
  const { session, refresh } = useSession();
  const canTransfer = useCan("organization.transfer");
  const organization = session!.profile!.organization!;
  const [to, setTo] = useState("");
  const [open, setOpen] = useState(false);
  const others = (members ?? []).filter((m) => !m.you);
  const chosen = others.find((m) => m.userId === to);
  const transfer = useSubmit(async () => {
    await api.organization.transferOwnership({ userId: to });
    setOpen(false);
    setTo("");
    await refresh();
    onDone();
    toast(`${chosen?.name ?? "They"} owns ${organization.name} now`, {
      description: "You're an admin. You both got an email.",
      tone: "success",
    });
  });
  if (!canTransfer) return null;
  return (
    <Card>
      <CardHeader
        title="Transfer ownership"
        description="Make another member the owner. You become an admin."
      />
      <CardBody className="flex flex-wrap items-end gap-3">
        <Field label="New owner" className="min-w-56 flex-1">
          <Select
            value={to}
            onValueChange={setTo}
            placeholder={others.length ? "Pick a member" : "Invite someone first"}
            disabled={!others.length}
            options={others.map((m) => ({ value: m.userId, label: `${m.name} (${m.role})` }))}
          />
        </Field>
        <Button variant="outline" disabled={!chosen} onClick={() => setOpen(true)}>
          Transfer ownership
        </Button>
      </CardBody>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`Make ${chosen?.name ?? "them"} the owner?`}
          description={`You'll become an admin of ${organization.name}. Only an owner can make you an owner again.`}
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void transfer.run();
            }}
          >
            <FormError message={transfer.error} />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={transfer.pending}>
                Transfer ownership
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function LeaveCard({ members }: { members: Member[] | null }) {
  const api = useApi();
  const nav = useNav();
  const { session, refresh } = useSession();
  const organization = session!.profile!.organization!;
  const [open, setOpen] = useState(false);
  const me = members?.find((m) => m.you);
  const owners = members?.filter((m) => isOwnerRole(m.role)).length ?? 0;
  const lastOwner = Boolean(me && isOwnerRole(me.role) && owners <= 1);
  const leave = useSubmit(async () => {
    const { next } = await api.organization.leave();
    setOpen(false);
    await refresh();
    toast(`You left ${organization.name}`, { tone: "success" });
    nav.navigate(next ? "/" : "/onboarding", { replace: true });
  });
  return (
    <Card>
      <CardHeader
        title={`Leave ${ORGANIZATION_NOUN.one}`}
        description={`You'll lose access to ${organization.name} at once. Someone can invite you back.`}
        actions={
          <Button variant="outline" size="sm" disabled={lastOwner} onClick={() => setOpen(true)}>
            Leave
          </Button>
        }
      />
      {lastOwner ? (
        <CardBody>
          <Alert tone="warning">
            {organization.name} needs at least one owner. Make someone else an owner first, or
            delete the {ORGANIZATION_NOUN.one}.
          </Alert>
        </CardBody>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`Leave ${organization.name}?`}
          description="Your connected apps for it are disconnected too."
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void leave.run();
            }}
          >
            <Alert tone="warning">You're about to lose access to {organization.name}.</Alert>
            <FormError message={leave.error} />
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" submitShortcut loading={leave.pending}>
                Leave {ORGANIZATION_NOUN.one}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DeleteCard() {
  const api = useApi();
  const nav = useNav();
  const { session, refresh } = useSession();
  const canDelete = useCan("organization.delete");
  const organization = session!.profile!.organization!;
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const remove = useSubmit(async () => {
    const { next } = await api.organization.delete({ confirmName });
    setOpen(false);
    await refresh();
    toast(`${organization.name} was deleted`, { tone: "success" });
    nav.navigate(next ? "/" : "/onboarding", { replace: true });
  });
  if (!canDelete) return null;
  const matches = confirmName.trim().toLowerCase() === organization.name.trim().toLowerCase();
  return (
    <Card className="border-danger/40">
      <CardHeader
        title={`Delete ${ORGANIZATION_NOUN.one}`}
        description="Every member loses access at once. Connected apps and Zapier connections are turned off and automations stop."
        actions={
          <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
            Delete {ORGANIZATION_NOUN.one}
          </Button>
        }
      />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setConfirmName("");
        }}
      >
        <DialogContent
          title={`Delete ${organization.name}?`}
          description="Support can restore it for 30 days. After that, it and everything in it are gone for good."
        >
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (matches) void remove.run();
            }}
          >
            <Alert tone="warning">
              Everyone in {organization.name} loses access as soon as you delete it.
            </Alert>
            <FormError message={remove.error} />
            <Field label={`Type ${organization.name} to confirm`} error={remove.fields.confirmName}>
              <Input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
                autoFocus
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                submitShortcut
                loading={remove.pending}
                disabled={!matches}
              >
                Delete {ORGANIZATION_NOUN.one}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
