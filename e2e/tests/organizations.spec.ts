import { expect, test } from "@playwright/test";
import { deleteAccount, E2E_PASSWORD, e2eEmail, linkFor, signUpWithCompany } from "./helpers";

/**
 * Inviting a crew member end to end (`specs/organizations.md`, "Testing"): an owner invites a
 * throwaway address, the e2e reads the link from the test mailbox, the invitee signs up from it
 * and lands in the company as a member, can't see Invite member, and is removed by the owner.
 * Both throwaway accounts are deleted at the end.
 */
test("invite someone, they join as a member, and the owner removes them", async ({
  browser,
  request,
}) => {
  const ownerPage = await (await browser.newContext()).newPage();
  await signUpWithCompany(ownerPage, "E2E Brickley");
  const company = "E2E Brickley's company";

  await ownerPage.goto("/settings/members");
  await ownerPage.getByRole("button", { name: "Invite member" }).click();
  const invitee = e2eEmail();
  const dialog = ownerPage.getByRole("dialog");
  await dialog.getByLabel("Email").fill(invitee);
  await dialog.getByRole("button", { name: "Send invite" }).click();
  await expect(ownerPage.getByText("Invitation sent", { exact: true })).toBeVisible();
  await expect(ownerPage.getByText(invitee, { exact: true })).toBeVisible();

  // The invitee, in their own browser, from the emailed link.
  const memberPage = await (await browser.newContext()).newPage();
  await memberPage.goto(await linkFor(request, invitee, /invited you to/));
  await expect(memberPage.getByRole("heading", { name: `Join ${company}` })).toBeVisible();
  await memberPage.getByRole("link", { name: "Create an account" }).click();
  await expect(memberPage.getByLabel("Email", { exact: true })).toHaveValue(invitee);
  await memberPage.getByLabel("Your name").fill("E2E Piglet");
  await memberPage.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await memberPage.getByRole("button", { name: "Create account" }).click();
  await memberPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(memberPage.getByRole("heading", { name: /Welcome, E2E/ })).toBeVisible();
  await expect(memberPage.getByRole("button", { name: new RegExp(company) })).toBeVisible();

  await memberPage.goto("/settings/members");
  await expect(memberPage.getByRole("cell", { name: /E2E Brickley/ })).toBeVisible();
  await expect(memberPage.getByRole("button", { name: "Invite member" })).toHaveCount(0);

  // The owner removes them; their next request finds them signed out of it.
  await ownerPage.reload();
  const row = ownerPage.getByRole("row", { name: /E2E Piglet/ });
  await row.getByRole("button", { name: "Remove" }).click();
  await ownerPage.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(ownerPage.getByText("E2E Piglet was removed", { exact: true })).toBeVisible();
  await memberPage.reload();
  await expect(memberPage).toHaveURL(/\/sign-in/);

  // Clean up: the invitee signs in (to no company) and deletes their account; so does the owner.
  await memberPage.getByLabel("Email", { exact: true }).fill(invitee);
  await memberPage.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await memberPage.getByRole("button", { name: "Sign in" }).click();
  await expect(memberPage.getByRole("heading", { name: "Name your company" })).toBeVisible();
  await deleteAccount(memberPage);
  await deleteAccount(ownerPage);
});
