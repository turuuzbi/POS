import { expect, test } from "@playwright/test";
import { en, enterPin, formAlert, mn, SEED, signInWithPassword, signOut } from "./fixtures";

test.describe("sign-in", () => {
  test("anonymous visitors are sent to sign-in", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: mn.auth.loginTitle })).toBeVisible();
  });

  test("wrong credentials show one generic error", async ({ page }) => {
    await signInWithPassword(page, "nobody@pos.local", "definitely-wrong", {
      expectSuccess: false,
    });
    await expect(formAlert(page)).toHaveText(mn.auth.invalid);
    await expect(page).toHaveURL(/\/login$/);
  });

  test("owner signs in, switches language, signs out", async ({ page }) => {
    await signInWithPassword(page, SEED.owner.email);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("heading", { name: mn.dashboard.greeting.replace("{name}", SEED.owner.name) }),
    ).toBeVisible();

    // Language switch persists across navigation.
    await page
      .getByRole("button", { name: `${mn.preferences.language} / ${mn.preferences.theme}` })
      .click();
    await page.getByRole("menuitemradio", { name: "English" }).click();
    await expect(
      page.getByRole("heading", { name: en.dashboard.greeting.replace("{name}", SEED.owner.name) }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `${en.preferences.language} / ${en.preferences.theme}` })
      .click();
    await page.getByRole("menuitemradio", { name: "Монгол" }).click();
    await expect(page.getByRole("link", { name: mn.nav.devices }).first()).toBeVisible();

    await signOut(page, SEED.owner.name, mn.auth.signOut);
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("register device + PIN", () => {
  test("manager pairs a tablet, cashier signs in with PIN and locks", async ({ page }) => {
    await signInWithPassword(page, SEED.manager.email);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByRole("link", { name: mn.nav.devices }).first().click();
    await expect(page).toHaveURL(/\/settings\/devices$/);
    await expect(page.getByText(mn.devices.thisDeviceNotPaired)).toBeVisible();

    const deviceName = `E2E tablet ${Date.now()}`;
    await page.getByLabel(mn.devices.name).fill(deviceName);
    await page.getByRole("button", { name: mn.devices.pair }).click();
    await expect(page.getByText(mn.devices.paired)).toBeVisible();
    await expect(page.getByRole("cell", { name: deviceName })).toBeVisible();

    // Signing out on a paired device returns to the PIN pad.
    await signOut(page, SEED.manager.name, mn.auth.signOut);
    await expect(page).toHaveURL(/\/pin$/);
    await expect(page.getByRole("heading", { name: mn.auth.pinTitle })).toBeVisible();

    await enterPin(page, "000000");
    await expect(formAlert(page)).toHaveText(mn.auth.pinInvalid);

    await enterPin(page, SEED.cashier.pin);
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByText(mn.pos.cashier.replace("{name}", SEED.cashier.name))).toBeVisible();
    // Cashiers have no back office.
    await expect(page.getByRole("link", { name: mn.pos.backOffice })).toHaveCount(0);

    await signOut(page, SEED.cashier.name, mn.auth.lock);
    await expect(page).toHaveURL(/\/pin$/);
  });

  test("cashiers cannot open manager pages", async ({ page }) => {
    // Pair as manager, then sign in as the cashier on the same device.
    await signInWithPassword(page, SEED.manager.email);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/settings/devices");
    await page.getByLabel(mn.devices.name).fill(`E2E guard ${Date.now()}`);
    await page.getByRole("button", { name: mn.devices.pair }).click();
    await expect(page.getByText(mn.devices.paired)).toBeVisible();
    await signOut(page, SEED.manager.name, mn.auth.signOut);

    await enterPin(page, SEED.cashier.pin);
    await expect(page).toHaveURL(/\/register$/);
    await page.goto("/settings/devices");
    await expect(page).toHaveURL(/\/forbidden$/);
    await expect(page.getByRole("heading", { name: mn.states.forbiddenTitle })).toBeVisible();
  });
});
