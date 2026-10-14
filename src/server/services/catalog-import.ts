import "server-only";
import { productInputSchema, type ProductFormValues, type ProductInput } from "@/domain/catalog";
import {
  formatCsvMoney,
  groupCatalogRows,
  parseCatalogCsv,
  type CsvColumn,
  type ImportIssue,
  type ImportIssueCode,
  type ProductGroup,
} from "@/domain/csv-catalog";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "../audit";
import type { Db, Tx } from "../db";
import type { RequestMeta } from "../request";
import { saveProduct, type Actor } from "./catalog";

/**
 * CSV catalog import. `planCatalogImport` is a pure dry run (reads only);
 * `commitCatalogImport` re-plans inside the caller's transaction and writes
 * every product through `saveProduct`, so nothing is applied unless the whole
 * file is valid.
 *
 * Matching: a row updates the existing variant that has its SKU (case-
 * insensitive) or one of its barcodes. Failing that, when product_key is the id
 * of an existing product (an exported file), the row matches that product's
 * variant with the same option values / variant name (variants may have no SKU
 * or barcode), so re-importing an unedited export changes nothing. Otherwise
 * it is a new variant. A group
 * of rows matching one existing product updates that product (variants not in
 * the file are kept as they are); matching two products is an error.
 * Blank optional cells keep the current value on update and take a default on
 * create. `cost` only applies to new variants (receiving maintains cost).
 */

export const PREVIEW_ROW_LIMIT = 50;
export const ISSUE_LIMIT = 200;
const CHUNK = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlanItem {
  action: "create" | "update";
  input: ProductInput & { id?: string };
  name: string;
  line: number;
  newVariants: number;
  updatedVariants: number;
}

export interface ImportPlan {
  issues: ImportIssue[];
  items: PlanItem[];
}

export interface ImportPreview {
  /** Total issues found (the list below is capped). */
  issueCount: number;
  issues: ImportIssue[];
  rowCount: number;
  create: number;
  update: number;
  newVariants: number;
  updatedVariants: number;
  items: { action: "create" | "update"; name: string; line: number; variants: number }[];
}

export function toPreview(plan: ImportPlan, rowCount: number): ImportPreview {
  const issues = [...plan.issues].sort((a, b) => a.line - b.line);
  const ok = issues.length === 0;
  return {
    issueCount: issues.length,
    issues: issues.slice(0, ISSUE_LIMIT),
    rowCount,
    create: ok ? plan.items.filter((i) => i.action === "create").length : 0,
    update: ok ? plan.items.filter((i) => i.action === "update").length : 0,
    newVariants: ok ? plan.items.reduce((n, i) => n + i.newVariants, 0) : 0,
    updatedVariants: ok ? plan.items.reduce((n, i) => n + i.updatedVariants, 0) : 0,
    items: ok
      ? plan.items.slice(0, PREVIEW_ROW_LIMIT).map((i) => ({
          action: i.action,
          name: i.name,
          line: i.line,
          variants: i.input.variants.length,
        }))
      : [],
  };
}

const chunks = <T>(values: T[]): T[][] =>
  Array.from({ length: Math.ceil(values.length / CHUNK) }, (_, i) =>
    values.slice(i * CHUNK, (i + 1) * CHUNK),
  );

const CATEGORY_SEPARATOR = /\s*[>›]\s*/;
const normalizePath = (path: string) =>
  path
    .split(CATEGORY_SEPARATOR)
    .map((part) => part.trim().toLowerCase())
    .join(" > ");

/** Where a product-level zod path points in the CSV. */
const FIELD_COLUMN: Record<string, CsvColumn> = {
  name: "name",
  description: "description",
  type: "type",
  unit: "unit",
  categoryId: "category",
  taxClassId: "tax_class",
  pricesIncludeTax: "prices_include_tax",
  trackStock: "track_stock",
  taxClassificationCode: "tax_classification_code",
  isActive: "product_active",
  options: "option1_name",
  variants: "name",
  sku: "sku",
  pluCode: "plu",
  barcodes: "barcodes",
  option1: "option1",
  option2: "option2",
  option3: "option3",
  price: "price",
  cost: "cost",
  name_variant: "variant_name",
};

type ExistingVariant = {
  id: string;
  sku: string | null;
  name: string | null;
  pluCode: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  price: bigint;
  isActive: boolean;
  position: number;
  productId: string;
  barcodes: { code: string }[];
};

export async function planCatalogImport(
  client: Db,
  text: string,
  options: { allowCost: boolean },
): Promise<ImportPlan & { rowCount: number }> {
  const parsed = parseCatalogCsv(text, { allowCost: options.allowCost });
  const issues: ImportIssue[] = [...parsed.issues];
  const rowCount = parsed.rows.length;
  // Row-level syntax errors are reported together with the file's other
  // problems, but the database is only consulted for a syntactically clean file.
  if (issues.length > 0) return { issues, items: [], rowCount };

  const { groups, issues: groupIssues } = groupCatalogRows(parsed.rows);
  issues.push(...groupIssues);
  if (issues.length > 0) return { issues, items: [], rowCount };

  const [taxClasses, categories, settings] = await Promise.all([
    client.taxClass.findMany({ select: { id: true, name: true, isActive: true } }),
    client.category.findMany({ select: { id: true, name: true, parentId: true, isActive: true } }),
    client.businessSettings.findUnique({ where: { id: 1 }, select: { defaultTaxClassId: true } }),
  ]);
  const taxByName = new Map(taxClasses.map((t) => [t.name.toLowerCase(), t]));
  const taxById = new Map(taxClasses.map((t) => [t.id, t]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    for (let c = categoryById.get(id), depth = 0; c && depth < 20; depth++) {
      parts.unshift(c.name);
      c = c.parentId ? categoryById.get(c.parentId) : undefined;
    }
    return normalizePath(parts.join(" > "));
  };
  const byPath = new Map<string, typeof categories>();
  const byName = new Map<string, typeof categories>();
  for (const category of categories) {
    for (const [map, key] of [
      [byPath, pathOf(category.id)],
      [byName, category.name.trim().toLowerCase()],
    ] as const) {
      map.set(key, [...(map.get(key) ?? []), category]);
    }
  }

  // Existing variants carrying any code used by the file.
  const skus = new Set<string>();
  const codes = new Set<string>();
  const plus = new Set<string>();
  for (const row of parsed.rows) {
    if (row.sku) skus.add(row.sku.toLowerCase());
    if (row.plu) plus.add(row.plu);
    row.barcodes.forEach((c) => codes.add(c));
  }
  const found = new Map<string, ExistingVariant>();
  const select = {
    id: true,
    sku: true,
    name: true,
    pluCode: true,
    option1: true,
    option2: true,
    option3: true,
    price: true,
    isActive: true,
    position: true,
    productId: true,
    barcodes: { select: { code: true } },
  } as const;
  for (const part of chunks([...skus])) {
    for (const v of await client.productVariant.findMany({
      where: { sku: { in: part, mode: "insensitive" } },
      select,
    })) {
      found.set(v.id, v);
    }
  }
  for (const part of chunks([...codes])) {
    for (const v of await client.productVariant.findMany({
      where: { barcodes: { some: { code: { in: part } } } },
      select,
    })) {
      found.set(v.id, v);
    }
  }
  const variantBySku = new Map<string, ExistingVariant>();
  const variantByCode = new Map<string, ExistingVariant>();
  for (const v of found.values()) {
    if (v.sku) variantBySku.set(v.sku.toLowerCase(), v);
    v.barcodes.forEach((b) => variantByCode.set(b.code, v));
  }
  const pluOwner = new Map<string, string>();
  for (const part of chunks([...plus])) {
    for (const v of await client.productVariant.findMany({
      where: { pluCode: { in: part } },
      select: { id: true, pluCode: true },
    })) {
      pluOwner.set(v.pluCode!, v.id);
    }
  }

  const items: PlanItem[] = [];
  for (const group of groups) {
    const item = await planGroup(client, group, {
      allowCost: options.allowCost,
      issues,
      taxByName,
      taxById,
      defaultTaxClassId: settings?.defaultTaxClassId ?? null,
      byPath,
      byName,
      categoryById,
      variantBySku,
      variantByCode,
      pluOwner,
    });
    if (item) items.push(item);
  }
  return { issues, items, rowCount };
}

interface GroupContext {
  allowCost: boolean;
  issues: ImportIssue[];
  taxByName: Map<string, { id: string; isActive: boolean }>;
  taxById: Map<string, { id: string; isActive: boolean }>;
  defaultTaxClassId: string | null;
  byPath: Map<string, { id: string; isActive: boolean }[]>;
  byName: Map<string, { id: string; isActive: boolean }[]>;
  categoryById: Map<string, { id: string; isActive: boolean }>;
  variantBySku: Map<string, ExistingVariant>;
  variantByCode: Map<string, ExistingVariant>;
  pluOwner: Map<string, string>;
}

async function planGroup(
  client: Db,
  group: ProductGroup,
  ctx: GroupContext,
): Promise<PlanItem | null> {
  const problems: ImportIssue[] = [];
  const flag = (line: number, column: CsvColumn | null, code: ImportIssueCode) =>
    problems.push({ line, column, code });
  const head = group.head;
  const firstLine = group.rows[0]!.line;

  // product_key from an export names the product itself.
  const productInclude = {
    options: { orderBy: { position: "asc" } },
    variants: {
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      include: { barcodes: true },
    },
  } satisfies Prisma.ProductInclude;
  const keyId =
    head.productKey && UUID.test(head.productKey) ? head.productKey.toLowerCase() : null;
  const keyed = keyId
    ? await client.product.findUnique({ where: { id: keyId }, include: productInclude })
    : null;

  // Which existing variant does each row hit?
  const matched: (ExistingVariant | undefined)[] = group.rows.map((row) => {
    const hits = new Set<ExistingVariant>();
    const bySku = row.sku ? ctx.variantBySku.get(row.sku.toLowerCase()) : undefined;
    if (bySku) hits.add(bySku);
    for (const code of row.barcodes) {
      const hit = ctx.variantByCode.get(code);
      if (hit) hits.add(hit);
    }
    if (hits.size > 1) {
      flag(row.line, row.sku ? "sku" : "barcodes", "ambiguousMatch");
      return undefined;
    }
    return [...hits][0];
  });
  const productIds = new Set(matched.flatMap((v) => (v ? [v.productId] : [])));
  if (keyed) {
    productIds.add(keyed.id);
    if (productIds.size === 1) {
      // Rows without a SKU/barcode hit: pair with the product's variant of the same options/name.
      const claimed = new Set(matched.flatMap((v) => (v ? [v.id] : [])));
      const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
      group.rows.forEach((row, i) => {
        if (matched[i] || row.sku || row.barcodes.length > 0) return;
        const candidate = keyed.variants.find(
          (v) =>
            !claimed.has(v.id) &&
            [v.option1, v.option2, v.option3].every(
              (o, slot) => norm(o) === norm(row.options[slot]),
            ) &&
            (row.variantName === undefined || norm(v.name) === norm(row.variantName)),
        );
        if (candidate) {
          matched[i] = candidate;
          claimed.add(candidate.id);
        }
      });
    }
  }
  if (productIds.size > 1) {
    group.rows.forEach((row, i) => {
      if (matched[i]) flag(row.line, row.sku ? "sku" : "barcodes", "ambiguousMatch");
    });
  }
  const seenVariant = new Set<string>();
  group.rows.forEach((row, i) => {
    const hit = matched[i];
    if (!hit) return;
    if (seenVariant.has(hit.id)) flag(row.line, row.sku ? "sku" : "barcodes", "ambiguousMatch");
    seenVariant.add(hit.id);
  });
  for (const [i, row] of group.rows.entries()) {
    if (row.plu) {
      const owner = ctx.pluOwner.get(row.plu);
      if (owner && owner !== matched[i]?.id) flag(row.line, "plu", "duplicate");
    }
  }
  if (problems.length > 0) {
    ctx.issues.push(...problems);
    return null;
  }

  const existingId = [...productIds][0] ?? null;
  const existing =
    keyed && keyed.id === existingId
      ? keyed
      : existingId
        ? await client.product.findUnique({ where: { id: existingId }, include: productInclude })
        : null;

  // Category and tax class by name.
  let categoryId: string | null = existing?.categoryId ?? null;
  if (head.category !== undefined) {
    const wanted = normalizePath(head.category);
    const exact = ctx.byPath.get(wanted);
    const loose = exact ?? ctx.byName.get(wanted);
    if (!loose || loose.length === 0) flag(firstLine, "category", "unknownCategory");
    else if (loose.length > 1) flag(firstLine, "category", "ambiguousCategory");
    else categoryId = loose[0]!.id;
  }
  let taxClassId: string | null = existing?.taxClassId ?? null;
  if (head.taxClass !== undefined) {
    const tax = ctx.taxByName.get(head.taxClass.toLowerCase());
    if (!tax) flag(firstLine, "tax_class", "unknownTaxClass");
    else taxClassId = tax.id;
  } else if (!existing) {
    taxClassId = ctx.defaultTaxClassId;
    if (!taxClassId) flag(firstLine, "tax_class", "required");
  }
  // Inactive references are rejected by saveProduct; surface them in the dry run.
  const taxRef = taxClassId ? ctx.taxById.get(taxClassId) : undefined;
  if (taxRef && !taxRef.isActive && taxClassId !== existing?.taxClassId) {
    flag(firstLine, "tax_class", "inactive");
  }
  const categoryRef = categoryId ? ctx.categoryById.get(categoryId) : undefined;
  if (categoryRef && !categoryRef.isActive && categoryId !== existing?.categoryId) {
    flag(firstLine, "category", "inactive");
  }

  // Variants: kept existing ones first (overlaid by their row), then new rows.
  const rowFor = new Map<string, number>();
  matched.forEach((hit, i) => {
    if (hit) rowFor.set(hit.id, i);
  });
  type VariantForm = ProductFormValues["variants"][number];
  const lines: number[] = [];
  const variants: VariantForm[] = [];
  let updatedVariants = 0;
  let newVariants = 0;
  for (const current of existing?.variants ?? []) {
    const index = rowFor.get(current.id);
    const row = index === undefined ? undefined : group.rows[index]!;
    if (row) updatedVariants++;
    variants.push({
      id: current.id,
      name: row?.variantName ?? current.name,
      // A SKU that only differs in case is the same SKU: keep the stored spelling.
      sku: row?.sku && row.sku.toLowerCase() !== current.sku?.toLowerCase() ? row.sku : current.sku,
      pluCode: row?.plu ?? current.pluCode,
      option1: row?.options[0] ?? current.option1,
      option2: row?.options[1] ?? current.option2,
      option3: row?.options[2] ?? current.option3,
      price: formatCsvMoney(row?.price ?? current.price),
      barcodes: row && row.barcodes.length > 0 ? row.barcodes : current.barcodes.map((b) => b.code),
      isActive: row?.variantActive ?? current.isActive,
    });
    lines.push(row?.line ?? firstLine);
  }
  for (const [i, row] of group.rows.entries()) {
    if (matched[i]) continue;
    newVariants++;
    if (row.price === undefined) flag(row.line, "price", "required");
    variants.push({
      name: row.variantName ?? null,
      sku: row.sku ?? null,
      pluCode: row.plu ?? null,
      option1: row.options[0] ?? null,
      option2: row.options[1] ?? null,
      option3: row.options[2] ?? null,
      price: formatCsvMoney(row.price ?? 0n),
      cost: row.cost === undefined ? undefined : formatCsvMoney(row.cost),
      barcodes: row.barcodes,
      isActive: row.variantActive ?? true,
    });
    lines.push(row.line);
  }

  // Options: names from the file (else the product's), values from its variants.
  const names = [0, 1, 2].map((slot) => group.optionNames[slot] ?? existing?.options[slot]?.name);
  const optionNames = names.slice(0, names.findLastIndex(Boolean) + 1);
  const formOptions = optionNames.map((name, slot) => ({
    name: name ?? "",
    values: [
      ...new Set(
        variants.flatMap((v) => {
          const value = [v.option1, v.option2, v.option3][slot];
          return value ? [value] : [];
        }),
      ),
    ],
  }));

  if (problems.length > 0) {
    ctx.issues.push(...problems);
    return null;
  }

  const type = head.type ?? existing?.type ?? "STANDARD";
  const form: ProductFormValues = {
    name: head.name,
    description: head.description ?? existing?.description ?? null,
    type,
    unit: head.unit ?? existing?.unit ?? "PIECE",
    categoryId,
    taxClassId: taxClassId!,
    pricesIncludeTax: head.pricesIncludeTax ?? existing?.pricesIncludeTax ?? true,
    trackStock: head.trackStock ?? existing?.trackStock ?? type === "STANDARD",
    taxClassificationCode: head.taxClassificationCode ?? existing?.taxClassificationCode ?? null,
    isActive: head.productActive ?? existing?.isActive ?? true,
    options: formOptions,
    variants,
  };
  const result = productInputSchema.safeParse(form);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const [root, index, field] = issue.path;
      const code = (issue.message || "invalid") as ImportIssueCode;
      if (root === "variants" && typeof index === "number") {
        const key = field === "name" ? "name_variant" : String(field ?? "");
        flag(lines[index] ?? firstLine, FIELD_COLUMN[key] ?? "name", code);
      } else {
        flag(firstLine, FIELD_COLUMN[String(root)] ?? "name", code);
      }
    }
    ctx.issues.push(...problems);
    return null;
  }
  return {
    action: existing ? "update" : "create",
    input: existing ? { ...result.data, id: existing.id } : result.data,
    name: head.name,
    line: firstLine,
    newVariants,
    updatedVariants,
  };
}

export interface ImportOutcome {
  committed: boolean;
  preview: ImportPreview;
}

/**
 * Apply an import in the caller's transaction. When the file has any issue
 * nothing is written and the preview (with the issues) is returned.
 */
export async function commitCatalogImport(
  tx: Tx,
  text: string,
  actor: Actor,
  options: { allowCost: boolean },
  meta: Partial<RequestMeta> = {},
): Promise<ImportOutcome> {
  const plan = await planCatalogImport(tx, text, options);
  const preview = toPreview(plan, plan.rowCount);
  if (plan.issues.length > 0) return { committed: false, preview };
  for (const item of plan.items) {
    await saveProduct(tx, item.input, actor, meta);
  }
  await audit(tx, {
    actorId: actor.id,
    action: "catalog.import",
    entityType: "Catalog",
    after: {
      rows: preview.rowCount,
      created: preview.create,
      updated: preview.update,
      newVariants: preview.newVariants,
      updatedVariants: preview.updatedVariants,
    },
    ...meta,
  });
  return { committed: true, preview };
}
