import { expect, test } from "@playwright/test";
import { E2E_PASSWORD, linkFor, signUpWithCompany } from "./helpers";

/**
 * The account, end to end in a browser: sign up, verify through the mailed link, update the
 * profile, then delete the account (so e2e users never pile up or touch the demo accounts).
 */
test("sign up, verify, update the profile and delete the account", async ({ page, request }) => {
  const email = await signUpWithCompany(page, "E2E Piglet");
  await expect(page.getByRole("heading", { name: /Welcome, E2E/ })).toBeVisible();
  await expect(page.getByText("Verify your email")).toBeVisible();

  await page.goto(await linkFor(request, email, /Verify your email/));
  await expect(page.getByText(`${email} is verified.`)).toBeVisible();

  await page.goto("/profile");
  await expect(page.getByText("Verified", { exact: true })).toBeVisible();
  await page.getByLabel("Job title (optional)").fill("Lead on Straw MVP. It shows");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Job title (optional)")).toHaveValue("Lead on Straw MVP. It shows");

  await page.getByRole("button", { name: "Delete account" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog.getByLabel("Current password").fill(E2E_PASSWORD);
  await dialog.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That email and password don't match an account.")).toBeVisible();
});

test("a signed-out visit to a signed-in page comes back after sign-in", async ({ page }) => {
  const email = await signUpWithCompany(page, "E2E Return");

  await page.context().clearCookies();
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fprofile/);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  // The submit shortcut. "Desktop Chrome" emulates Windows, where the chord is Ctrl+Enter.
  await page.keyboard.press("Control+Enter");
  await expect(page).toHaveURL(/\/profile$/);

  // Clean up.
  await page.getByRole("button", { name: "Delete account" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
  await dialog.getByLabel("Current password").fill(E2E_PASSWORD);
  await dialog.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
});
