import { expect, test, type Page } from "@playwright/test";
import { computeTotals, type Cart, type CatalogVariant } from "../../src/domain/cart";
import { formatMoney, fromMajor } from "../../src/domain/money";
import { resetSeedLocales } from "./db";
import { mn } from "./fixtures";
import {
  addByCode,
  addQuickKeys,
  cartLines,
  endRegister,
  msg,
  scaleLabel,
  seedEan,
  startRegister,
  type RegisterSession,
} from "./helpers/register";

/**
 * Register UI (Phase 2, slice "register"). Everything here runs WITHOUT the
 * checkout service: sales are never completed, only built up in the cart,
 * parked, priced and walked up to the tender dialog. Expected money comes from
 * the pure domain (the same code the page uses), so a wrong total fails.
 */

const money = (major: number) => formatMoney(fromMajor(major), { locale: "mn" });

/** The seed's tax-inclusive 10% VAT variants. */
const piece = (variantId: string, priceMajor: number): CatalogVariant => ({
  variantId,
  unit: "PIECE",
  price: fromMajor(priceMajor),
  pricesIncludeTax: true,
  taxTreatment: "STANDARD",
  vatRateBps: 1000,
  cityTaxRateBps: 0,
});
const kilo = (variantId: string, priceMajor: number): CatalogVariant => ({
  ...piece(variantId, priceMajor),
  unit: "KG",
});

function expected(cart: Cart, variants: CatalogVariant[]) {
  return computeTotals(
    cart,
    { variants: Object.fromEntries(variants.map((v) => [v.variantId, v])) },
    { totalRoundingUnit: 100n },
  );
}

const MILK = { sku: "DAIRY-MILK-1L", price: 3_800 };
const BREAD = { sku: "BAKERY-BREAD", price: 2_800 };
const BEEF = { name: "Үхрийн мах", plu: "101", price: 22_000 };

const payable = (page: Page) => page.getByTestId("total-payable");

let session: RegisterSession | undefined;

test.afterEach(async () => {
  await endRegister(session);
  session = undefined;
  await resetSeedLocales();
});

test.describe("shift gate", () => {
  test("without an open shift the register asks for the opening float", async ({ page }) => {
    session = await startRegister(page, { shift: false });
    const screen = page.getByTestId("open-shift");
    await expect(screen).toBeVisible();
    await expect(screen.getByRole("heading", { name: mn.pos.shift.title })).toBeVisible();
    await expect(screen.getByLabel(mn.pos.shift.openingFloat)).toBeVisible();
    await expect(screen.getByRole("button", { name: mn.pos.shift.open })).toBeEnabled();
    // No selling UI behind the gate.
    await expect(page.getByRole("combobox", { name: mn.pos.search.label })).toHaveCount(0);
    await expect(page.getByTestId("total-payable")).toHaveCount(0);
  });
});

test.describe("selling", () => {
  test.beforeEach(async ({ page }) => {
    session = await startRegister(page, { shift: true });
    await expect(page.getByRole("combobox", { name: mn.pos.search.label })).toBeFocused();
  });

  test("search adds lines, quantity and discount math match the domain", async ({ page }) => {
    const milk = piece("m", MILK.price);
    await addByCode(page, MILK.sku);
    await expect(cartLines(page)).toHaveCount(1);
    await expect(payable(page)).toHaveText(money(3_800));

    // Same item again merges into one line (qty 2), via the + button.
    await page
      .getByRole("button", { name: msg(mn.pos.cart.increase, { name: "Сүү 1 л" }) })
      .click();
    const twoMilk: Cart = {
      lines: [
        { lineId: "a", variantId: "m", qtyMilli: 2000, unitPrice: milk.price, discounts: [] },
      ],
      discounts: [],
    };
    await expect(payable(page)).toHaveText(money(7_600));
    const base = expected(twoMilk, [milk]);
    await expect(page.getByTestId("total-vat")).toHaveText(
      formatMoney(base.vatTotal, { locale: "mn" }),
    );

    // Add a second product by typing its name and picking the result.
    const search = page.getByRole("combobox", { name: mn.pos.search.label });
    await search.fill("Талх");
    await page
      .getByRole("option", { name: new RegExp("Талх") })
      .first()
      .click();
    await expect(cartLines(page)).toHaveCount(2);
    await expect(payable(page)).toHaveText(money(7_600 + BREAD.price));

    // A 10% line discount needs no approval and matches the domain math.
    await page
      .getByRole("button", { name: msg(mn.pos.cart.lineActions, { name: "Сүү 1 л" }) })
      .click();
    await page.getByRole("menuitem", { name: mn.pos.cart.discount }).click();
    const dialog = page.getByRole("dialog", { name: "Сүү 1 л" });
    await dialog.getByLabel(mn.pos.discount.percentLabel).fill("10");
    await dialog.getByRole("button", { name: mn.pos.discount.apply }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const discounted: Cart = {
      lines: [
        {
          ...twoMilk.lines[0]!,
          discounts: [{ kind: "PERCENT", percentBps: 1000 }],
        },
        {
          lineId: "b",
          variantId: "b",
          qtyMilli: 1000,
          unitPrice: fromMajor(BREAD.price),
          discounts: [],
        },
      ],
      discounts: [],
    };
    const totals = expected(discounted, [milk, piece("b", BREAD.price)]);
    await expect(payable(page)).toHaveText(formatMoney(totals.payable, { locale: "mn" }));
    await expect(page.getByTestId("total-discount")).toHaveText(
      `-${formatMoney(totals.discountTotal, { locale: "mn" })}`,
    );
    await expect(page.getByText(mn.pos.cart.needsApproval)).toHaveCount(0);
  });

  test("a weighed item takes decimals; a scale label adds weight and price itself", async ({
    page,
  }) => {
    const beef = kilo("beef", BEEF.price);
    const search = page.getByRole("combobox", { name: mn.pos.search.label });
    await search.fill(BEEF.name);
    await page
      .getByRole("option", { name: new RegExp(BEEF.name) })
      .first()
      .click();

    const qty = page.getByRole("dialog", { name: BEEF.name });
    await qty.getByLabel(msg(mn.pos.qty.labelWeighed, { unit: mn.units.KG })).fill("1.25");
    await qty.getByRole("button", { name: mn.pos.qty.apply }).click();
    const line: Cart = {
      lines: [
        { lineId: "a", variantId: "beef", qtyMilli: 1250, unitPrice: beef.price, discounts: [] },
      ],
      discounts: [],
    };
    await expect(payable(page)).toHaveText(
      formatMoney(expected(line, [beef]).payable, { locale: "mn" }),
    );
    await expect(payable(page)).toHaveText(money(27_500));

    // A decimal is rejected for pieces.
    await addByCode(page, MILK.sku);
    await page.getByRole("button", { name: new RegExp("Сүү 1 л: тоо хэмжээ") }).click();
    const pieces = page.getByRole("dialog", { name: "Сүү 1 л" });
    await pieces.getByLabel(mn.pos.qty.labelPieces).fill("2.5");
    // "." is not accepted by the pieces keypad, so the value collapses to a whole number.
    await expect(pieces.getByLabel(mn.pos.qty.labelPieces)).toHaveValue("25");
    await pieces.getByLabel(mn.pos.qty.labelPieces).fill("2");
    await pieces.getByRole("button", { name: mn.pos.qty.apply }).click();
    await expect(payable(page)).toHaveText(money(27_500 + 2 * MILK.price));

    // A price-embedded/weight label: 1.500 kg of PLU 101.
    await page.getByRole("button", { name: mn.pos.cart.clear }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: mn.pos.clearConfirm.confirm })
      .click();
    await expect(cartLines(page)).toHaveCount(0);
    await addByCode(page, scaleLabel(BEEF.plu, 1500));
    await expect(cartLines(page)).toHaveCount(1);
    await expect(payable(page)).toHaveText(money(33_000));
  });

  test("a USB scanner burst adds the product without stealing focus from text inputs", async ({
    page,
  }) => {
    const search = page.getByRole("combobox", { name: mn.pos.search.label });
    // Typing by hand into the search box is never swallowed.
    await search.pressSequentially("abcd", { delay: 5 });
    await expect(search).toHaveValue("abcd");
    await search.fill("");

    // Focus on the page body: a fast burst + Enter is a scan.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.type(seedEan(1), { delay: 4 });
    await page.keyboard.press("Enter");
    await expect(cartLines(page)).toHaveCount(1);
    await expect(payable(page)).toHaveText(money(MILK.price));
    // Scanner characters never landed in the search box.
    await expect(search).toHaveValue("");

    // Slow typing on the body is not a scan.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.type(seedEan(7), { delay: 120 });
    await page.keyboard.press("Enter");
    await expect(cartLines(page)).toHaveCount(1);

    // A scan while a text input has focus goes through that input (search Enter).
    await search.focus();
    await search.pressSequentially(seedEan(7), { delay: 4 });
    await search.press("Enter");
    await expect(cartLines(page)).toHaveCount(2);
    await expect(search).toHaveValue("");
  });

  test("an unknown barcode says so and leaves the cart alone", async ({ page }) => {
    await addByCode(page, "0000000000000");
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: "0000000000000" }),
    ).toBeVisible();
    await expect(cartLines(page)).toHaveCount(0);
  });

  test("a discount above 10% asks for a manager PIN, which then approves it", async ({ page }) => {
    await addByCode(page, MILK.sku);
    await page
      .getByRole("button", { name: msg(mn.pos.cart.lineActions, { name: "Сүү 1 л" }) })
      .click();
    await page.getByRole("menuitem", { name: mn.pos.cart.discount }).click();
    const discount = page.getByRole("dialog", { name: "Сүү 1 л" });
    await discount.getByLabel(mn.pos.discount.percentLabel).fill("15");
    await expect(
      discount.getByText(msg(mn.pos.discount.needsApproval, { percent: 10 })),
    ).toBeVisible();
    await discount.getByRole("button", { name: mn.pos.discount.apply }).click();

    // The approval dialog appears straight away.
    const approval = page.getByRole("dialog", { name: mn.pos.approval.title });
    await expect(approval).toBeVisible();
    await expect(
      approval.getByText(msg(mn.pos.approval.lineDiscount, { name: "Сүү 1 л" })),
    ).toBeVisible();

    // A wrong PIN is refused and the discount stays unapproved.
    await approval.getByLabel(mn.pos.approval.pinLabel).fill("000000");
    await approval.getByRole("button", { name: mn.pos.approval.approve }).click();
    await expect(approval.getByRole("alert")).toHaveText(mn.pos.approval.invalidPin);

    // Cancel: the line is flagged and Charge goes to approval, not to payment.
    await approval.getByRole("button", { name: mn.pos.approval.cancel }).click();
    await expect(page.getByText(mn.pos.cart.needsApproval)).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^${mn.pos.cart.charge}`) }).click();
    await expect(page.getByRole("dialog", { name: mn.pos.approval.title })).toBeVisible();

    // The manager's real PIN approves it; payment opens (Charge asked for it).
    await page.getByLabel(mn.pos.approval.pinLabel).fill("583920");
    await page.getByRole("button", { name: mn.pos.approval.approve }).click();
    await expect(page.getByRole("dialog", { name: mn.pos.tender.title })).toBeVisible();
    const totals = expected(
      {
        lines: [
          {
            lineId: "a",
            variantId: "m",
            qtyMilli: 1000,
            unitPrice: fromMajor(MILK.price),
            discounts: [{ kind: "PERCENT", percentBps: 1500 }],
          },
        ],
        discounts: [],
      },
      [piece("m", MILK.price)],
    );
    await expect(page.getByTestId("tender-payable")).toHaveText(
      formatMoney(totals.payable, { locale: "mn" }),
    );
  });

  test("a price override also needs approval", async ({ page }) => {
    await addByCode(page, MILK.sku);
    await page
      .getByRole("button", { name: msg(mn.pos.cart.lineActions, { name: "Сүү 1 л" }) })
      .click();
    await page.getByRole("menuitem", { name: mn.pos.cart.changePrice }).click();
    const dialog = page.getByRole("dialog", { name: "Сүү 1 л" });
    await dialog.getByLabel(mn.pos.price.label).fill("3000");
    await dialog.getByRole("button", { name: mn.pos.price.apply }).click();
    await expect(page.getByRole("dialog", { name: mn.pos.approval.title })).toBeVisible();
  });

  test("hold and resume survive a reload, and each cart keeps its own sale id", async ({
    page,
  }) => {
    await addByCode(page, MILK.sku);
    await addByCode(page, BREAD.sku);
    const draftKey = (await page.evaluate(() =>
      Object.keys(localStorage).find((k) => k.startsWith("pos:draft:")),
    ))!;
    const firstSale = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k)!).saleId,
      draftKey,
    );

    // The cart in progress survives a reload with the same sale id.
    await page.reload();
    await expect(cartLines(page)).toHaveCount(2);
    await expect(payable(page)).toHaveText(money(MILK.price + BREAD.price));
    const afterReload = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k)!).saleId,
      draftKey,
    );
    expect(afterReload).toBe(firstSale);

    // Hold it: the register is empty again, with a NEW sale id for the next cart.
    await page.getByRole("button", { name: mn.pos.cart.hold, exact: true }).click();
    await expect(cartLines(page)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: msg(mn.pos.cart.held, { count: 1 }) }),
    ).toBeVisible();
    await addByCode(page, BREAD.sku);
    await expect(cartLines(page)).toHaveCount(1);
    const secondSale = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k)!).saleId,
      draftKey,
    );
    expect(secondSale).not.toBe(firstSale);

    // Reload: held carts persist.
    await page.reload();
    await page.getByRole("button", { name: msg(mn.pos.cart.held, { count: 1 }) }).click();
    const held = page.getByRole("dialog", { name: mn.pos.held.title });
    const list = held.getByTestId("held-list");
    await expect(list.getByRole("listitem")).toHaveCount(1);
    await expect(list).toContainText(money(MILK.price + BREAD.price));

    // Resume: the current cart is parked in turn and the held one comes back whole.
    await list.getByRole("button", { name: mn.pos.held.resume }).click();
    await expect(cartLines(page)).toHaveCount(2);
    await expect(payable(page)).toHaveText(money(MILK.price + BREAD.price));
    const resumedSale = await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k)!).saleId,
      draftKey,
    );
    expect(resumedSale).toBe(firstSale);
    await expect(
      page.getByRole("button", { name: msg(mn.pos.cart.held, { count: 1 }) }),
    ).toBeVisible();

    // Discard the parked bread cart.
    await page.getByRole("button", { name: msg(mn.pos.cart.held, { count: 1 }) }).click();
    await page.getByRole("button", { name: mn.pos.held.discard }).click();
    await page.getByRole("button", { name: mn.pos.held.confirmDiscard }).click();
    await expect(page.getByText(mn.pos.held.empty)).toBeVisible();
  });

  test("the tender dialog validates amounts, splits and shows change", async ({ page }) => {
    await addByCode(page, MILK.sku); // 3 800₮
    await page.getByRole("button", { name: new RegExp(`^${mn.pos.cart.charge}`) }).click();
    const dialog = page.getByRole("dialog", { name: mn.pos.tender.title });
    await expect(dialog.getByTestId("tender-payable")).toHaveText(money(3_800));
    await expect(dialog.getByTestId("tender-remaining")).toHaveText(money(3_800));

    // Quick amounts from the domain: exact, then round-ups to the notes.
    const quick = dialog.getByRole("group", { name: mn.pos.tender.quickAmounts });
    await expect(quick.getByRole("button")).toHaveText([
      money(3_800),
      money(4_000),
      money(5_000),
      money(10_000),
      money(20_000),
    ]);

    // Cash: 5 000₮ given -> 1 200₮ change, previewed before it is applied.
    const given = dialog.getByLabel(mn.pos.tender.cashGiven);
    await given.fill("5000");
    await expect(dialog.getByTestId("change-preview")).toHaveText(money(1_200));

    // Partial cash first (split): 1 000₮ leaves 2 800₮.
    await given.fill("1000");
    await dialog.getByRole("button", { name: mn.pos.tender.addPartial }).click();
    await expect(dialog.getByTestId("tender-remaining")).toHaveText(money(2_800));
    await expect(dialog.getByRole("list", { name: mn.pos.tender.applied })).toContainText(
      money(1_000),
    );

    // Bank transfer needs a reference.
    await dialog.getByRole("radio", { name: mn.pos.tender.method.BANK_TRANSFER }).click();
    await dialog.getByRole("button", { name: mn.pos.tender.addPayment }).click();
    await expect(dialog.getByRole("alert")).toHaveText(mn.pos.tender.errors.reference);

    // A card payment cannot exceed the balance.
    await dialog.getByRole("radio", { name: mn.pos.tender.method.CARD }).click();
    await dialog.getByLabel(mn.pos.tender.amount).fill("9000");
    await dialog.getByRole("button", { name: mn.pos.tender.addPayment }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      msg(mn.pos.tender.errors.exceeds, { remaining: money(2_800) }),
    );

    // The exact remainder in card settles the sale; Complete is offered.
    await dialog.getByLabel(mn.pos.tender.amount).fill("2800");
    await dialog.getByRole("button", { name: mn.pos.tender.addPayment }).click();
    await expect(dialog.getByTestId("tender-remaining")).toHaveText(money(0));
    await expect(dialog.getByRole("button", { name: mn.pos.tender.complete })).toBeEnabled();

    // QPay is offered for a fresh balance (not created here).
    await dialog.getByRole("button", { name: mn.pos.tender.removeTender }).last().click();
    await dialog.getByRole("radio", { name: mn.pos.tender.method.QPAY }).click();
    await expect(dialog.getByRole("button", { name: /QR/ })).toBeVisible();
  });

  test("quick keys fill the favourites tab; a product with variants asks which one", async ({
    page,
  }) => {
    const cleanup = await addQuickKeys([
      { name: "Сүү 1 л", color: "blue" },
      { name: "Ус", color: "teal" },
    ]);
    try {
      await page.reload();
      await expect(page.getByRole("tab", { name: mn.pos.grid.favourites })).toBeVisible();
      // Browse fallback is gone: only the quick keys are tiles.
      await expect(page.getByRole("tab", { name: mn.pos.grid.all })).toHaveCount(0);
      const tabpanel = page.getByRole("tabpanel");
      await expect(tabpanel.getByRole("button")).toHaveCount(2);

      await tabpanel.getByRole("button", { name: /Сүү 1 л/ }).click();
      await expect(cartLines(page)).toHaveCount(1);
      await expect(payable(page)).toHaveText(money(MILK.price));
      await tabpanel.getByRole("button", { name: /Сүү 1 л/ }).click();
      await expect(cartLines(page)).toHaveCount(1); // merged
      await expect(payable(page)).toHaveText(money(2 * MILK.price));

      // "Ус" has three sizes: a chooser opens.
      await tabpanel.getByRole("button", { name: /Ус/ }).click();
      const chooser = page.getByRole("dialog", { name: "Ус" });
      await expect(chooser.getByRole("button")).toHaveCount(4); // 3 variants + close
      await chooser.getByRole("button", { name: /1\.5 л/ }).click();
      await expect(cartLines(page)).toHaveCount(2);
      await expect(payable(page)).toHaveText(money(2 * MILK.price + 2_000));
    } finally {
      await cleanup();
    }
  });

  test("keyboard: / focuses search, ? opens the shortcut help", async ({ page }) => {
    const search = page.getByRole("combobox", { name: mn.pos.search.label });
    await page
      .getByRole("button", { name: new RegExp(`^${mn.pos.cart.hold}`) })
      .first()
      .focus();
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("?");
    const help = page.getByRole("heading", { name: mn.pos.help.title });
    await expect(help).toBeVisible();
    await expect(page.getByText("F2", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
  });

  test("the camera scanner reports an unusable camera instead of hanging", async ({ page }) => {
    await page.getByRole("button", { name: mn.pos.search.camera }).click();
    const dialog = page.getByRole("dialog", { name: mn.pos.camera.title });
    await expect(dialog).toBeVisible();
    // Headless Chromium has no camera / no permission: one of the problem states shows.
    await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: mn.pos.camera.done }).click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe("responsive layout", () => {
  const noHorizontalScroll = async (page: Page) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  };

  for (const [name, size] of [
    ["phone 360x740", { width: 360, height: 740 }],
    ["tablet 1180x820", { width: 1180, height: 820 }],
    ["desktop 1366x768", { width: 1366, height: 768 }],
  ] as const) {
    test(`no horizontal overflow and 44px targets on ${name}`, async ({ page }) => {
      await page.setViewportSize(size);
      session = await startRegister(page, { shift: true });
      await addByCode(page, MILK.sku);
      await addByCode(page, BREAD.sku);
      await noHorizontalScroll(page);

      const phone = size.width < 1024;
      if (phone) {
        // The cart is a full-screen panel behind the bottom bar.
        await expect(page.getByTestId("total-payable")).toBeHidden();
        await page.getByRole("button", { name: msg(mn.pos.cart.open, { count: 2 }) }).click();
      }
      await expect(page.getByTestId("total-payable")).toBeVisible();
      await noHorizontalScroll(page);

      const targets = [
        page.getByRole("button", { name: new RegExp(`^${mn.pos.cart.charge}`) }),
        page.getByRole("button", { name: msg(mn.pos.cart.increase, { name: "Сүү 1 л" }) }),
        page.getByRole("button", { name: msg(mn.pos.cart.remove, { name: "Сүү 1 л" }) }),
      ];
      for (const target of targets) {
        const box = await target.boundingBox();
        expect(box, "target is visible").not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }

      if (phone) {
        await page.getByRole("button", { name: mn.pos.cart.backToItems }).click();
        const search = await page
          .getByRole("combobox", { name: mn.pos.search.label })
          .boundingBox();
        expect(search!.height).toBeGreaterThanOrEqual(44);
        for (const tile of await page.locator("main button:has(> span.absolute)").all()) {
          const box = await tile.boundingBox();
          if (box) expect(box.height).toBeGreaterThanOrEqual(44);
        }
      }
    });
  }

  test("dark theme keeps the layout intact", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    session = await startRegister(page, { shift: true });
    await addByCode(page, MILK.sku);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(payable(page)).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
