import { expect, type Page } from "@playwright/test";
import en from "../../messages/en";
import mn from "../../messages/mn";

/** Seeded development accounts (prisma/seed.ts). */
export const SEED = {
  password: process.env.SEED_OWNER_PASSWORD ?? "demo-password-2026",
  owner: { email: "owner@pos.local", name: "Бат-Эрдэнэ" },
  manager: { email: "manager@pos.local", name: "Сарантуяа" },
  cashier: { name: "Болор", pin: "482109" },
};

export { en, mn };

export async function signInWithPassword(
  page: Page,
  email: string,
  password = SEED.password,
  { expectSuccess = true } = {},
) {
  await page.goto("/login");
  await page.getByLabel(mn.auth.email).fill(email);
  await page.getByLabel(mn.auth.password).fill(password);
  await page.getByRole("button", { name: mn.auth.submit }).click();
  if (expectSuccess) await expect(page).not.toHaveURL(/\/login/);
}

/** The page's own alert (Next's route announcer also uses role="alert"). */
export function formAlert(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

export async function enterPin(page: Page, pin: string) {
  for (const digit of pin) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
  await page.getByRole("button", { name: mn.auth.submit }).click();
}

export async function signOut(page: Page, menuName: string, item: string) {
  await page.getByRole("button", { name: menuName }).click();
  await page.getByRole("menuitem", { name: item }).click();
  await expect(page).not.toHaveURL(/\/(dashboard|register)/);
  // Regression: a redirecting action must not surface as an error toast.
  await expect(page.locator("[data-sonner-toast][data-type=error]")).toHaveCount(0);
}
