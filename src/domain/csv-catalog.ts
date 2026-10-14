/**
 * Catalog CSV: RFC 4180 parser and serializer plus row validation for the
 * product import/export (pure; shared by the server and tests).
 *
 * One CSV row is one variant. Rows of the same product share a `product_key`
 * (or, without one, the same `name`). Issues carry stable codes and 1-based
 * line numbers (physical lines, so rows with embedded newlines still point at
 * the line where the record starts); the UI translates the codes.
 */
import { z } from "zod";
import {
  MAX_BARCODES_PER_VARIANT,
  PRODUCT_TYPES,
  VALIDATION_CODES,
  barcodeField,
  moneyField,
  optionalText,
  pluField,
  requiredText,
  skuField,
  type ValidationCode,
} from "./catalog";
import { UNITS } from "./qty";

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/** Separates several barcodes inside one cell. */
export const BARCODE_SEPARATOR = ";";

/** Columns in export order. `cost` is only written for users who may see costs. */
export const CSV_COLUMNS = [
  "product_key",
  "name",
  "description",
  "type",
  "unit",
  "category",
  "tax_class",
  "prices_include_tax",
  "track_stock",
  "tax_classification_code",
  "product_active",
  "option1_name",
  "option2_name",
  "option3_name",
  "variant_name",
  "sku",
  "plu",
  "barcodes",
  "option1",
  "option2",
  "option3",
  "price",
  "cost",
  "variant_active",
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];
const REQUIRED_COLUMNS: readonly CsvColumn[] = ["name", "price"];

export const IMPORT_ISSUE_CODES = [
  ...VALIDATION_CODES,
  "empty",
  "tooLarge",
  "tooManyRows",
  "unterminatedQuote",
  "badQuote",
  "badEncoding",
  "unknownColumn",
  "duplicateColumn",
  "missingColumn",
  "columnCount",
  "invalidBool",
  "invalidEnum",
  "duplicateInFile",
  "productConflict",
  "unknownCategory",
  "ambiguousCategory",
  "unknownTaxClass",
  "ambiguousMatch",
  "costNotAllowed",
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];

export interface ImportIssue {
  /** 1-based line of the offending record; 0 for whole-file problems. */
  line: number;
  column: CsvColumn | null;
  code: ImportIssueCode;
}

// ── Parser ────────────────────────────────────────────────────────────────

export interface CsvRecord {
  line: number;
  cells: string[];
}

/**
 * RFC 4180 reader: quoted fields with "" escapes, embedded commas and
 * newlines, CRLF / LF / lone-CR record separators, optional UTF-8 BOM.
 * Blank lines are skipped. A quote inside an unquoted field is kept literally
 * (Excel is lenient about that); text after a closing quote is `badQuote`.
 */
export function parseCsv(input: string): { records: CsvRecord[]; issues: ImportIssue[] } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  const issues: ImportIssue[] = [];
  let cells: string[] = [];
  let field = "";
  let line = 1;
  let recordLine = 1;
  let inQuotes = false;
  let quoteLine = 1;
  let fieldQuoted = false;
  let recordQuoted = false;
  let badQuoteReported = false;

  const endField = () => {
    cells.push(field);
    field = "";
    fieldQuoted = false;
  };
  const endRecord = () => {
    endField();
    const blank = cells.length === 1 && cells[0] === "" && !recordQuoted;
    if (!blank) records.push({ line: recordLine, cells });
    cells = [];
    recordQuoted = false;
    badQuoteReported = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          const next = text[i + 1];
          if (next !== undefined && next !== "," && next !== "\r" && next !== "\n") {
            if (!badQuoteReported) issues.push({ line, column: null, code: "badQuote" });
            badQuoteReported = true;
          }
        }
      } else {
        if (ch === "\r") {
          if (text[i + 1] === "\n") {
            field += "\r\n";
            i++;
          } else field += ch;
          line++;
        } else {
          if (ch === "\n") line++;
          field += ch;
        }
      }
      continue;
    }
    if (ch === ",") {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else if (ch === '"' && field === "" && !fieldQuoted) {
      inQuotes = true;
      fieldQuoted = true;
      recordQuoted = true;
      quoteLine = line;
    } else {
      field += ch;
    }
  }
  if (inQuotes) {
    issues.push({ line: quoteLine, column: null, code: "unterminatedQuote" });
  } else if (field !== "" || cells.length > 0 || fieldQuoted) {
    endRecord();
  }
  return { records, issues };
}

// ── Serializer ────────────────────────────────────────────────────────────

/** Spreadsheets run cells that start with these as formulas. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** Undo `escapeFormula` on import: an apostrophe that only protects a formula start. */
const ESCAPED_FORMULA = /^'[=+\-@\t\r]/;

/** Neutralise spreadsheet formula injection by prefixing an apostrophe. */
export function escapeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** One RFC 4180 field (quotes only when needed). */
export function csvField(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** A text cell: formula-safe and quoted as needed. */
export function csvText(value: string | null | undefined): string {
  return csvField(escapeFormula(value ?? ""));
}

/** A CSV record (CRLF terminated). Cells must already be `csvText` / `csvField` output. */
export function csvLine(fields: readonly string[]): string {
  return `${fields.join(",")}\r\n`;
}

/** UTF-8 byte order mark, so Excel opens Mongolian text correctly. */
export const CSV_BOM = "﻿";

/** möngö → "12500" or "12500.50" (no grouping, so it survives any locale). */
export function formatCsvMoney(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const major = abs / 100n;
  const minor = abs % 100n;
  const text = minor === 0n ? `${major}` : `${major}.${minor.toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

export function csvHeader(withCosts: boolean): string {
  return csvLine(CSV_COLUMNS.filter((c) => withCosts || c !== "cost"));
}

export interface ExportVariant {
  name: string | null;
  sku: string | null;
  pluCode: string | null;
  barcodes: string[];
  option1: string | null;
  option2: string | null;
  option3: string | null;
  price: bigint;
  cost: bigint;
  isActive: boolean;
}

export interface ExportProduct {
  id: string;
  name: string;
  description: string | null;
  type: string;
  unit: string;
  /** Display path of the category (parent > child), or null. */
  categoryPath: string | null;
  taxClassName: string;
  pricesIncludeTax: boolean;
  trackStock: boolean;
  taxClassificationCode: string | null;
  isActive: boolean;
  optionNames: string[];
  variants: ExportVariant[];
}

/** CSV text for one product: one record per variant. */
export function productToCsv(product: ExportProduct, withCosts: boolean): string {
  const bool = (value: boolean) => (value ? "true" : "false");
  return product.variants
    .map((variant) => {
      const values: Record<CsvColumn, string> = {
        product_key: csvText(product.id),
        name: csvText(product.name),
        description: csvText(product.description),
        type: csvText(product.type),
        unit: csvText(product.unit),
        category: csvText(product.categoryPath),
        tax_class: csvText(product.taxClassName),
        prices_include_tax: bool(product.pricesIncludeTax),
        track_stock: bool(product.trackStock),
        tax_classification_code: csvText(product.taxClassificationCode),
        product_active: bool(product.isActive),
        option1_name: csvText(product.optionNames[0]),
        option2_name: csvText(product.optionNames[1]),
        option3_name: csvText(product.optionNames[2]),
        variant_name: csvText(variant.name),
        sku: csvText(variant.sku),
        plu: csvText(variant.pluCode),
        barcodes: csvText(variant.barcodes.join(BARCODE_SEPARATOR)),
        option1: csvText(variant.option1),
        option2: csvText(variant.option2),
        option3: csvText(variant.option3),
        price: formatCsvMoney(variant.price),
        cost: formatCsvMoney(variant.cost),
        variant_active: bool(variant.isActive),
      };
      return csvLine(CSV_COLUMNS.filter((c) => withCosts || c !== "cost").map((c) => values[c]));
    })
    .join("");
}

/**
 * Downloadable example: a simple product and one with two variants. Category
 * and tax class are left blank (default tax class applies) so the untouched
 * template imports on any business, whatever its categories and tax classes.
 */
export function templateCsv(withCosts: boolean): string {
  const base = {
    description: null,
    type: "STANDARD",
    unit: "PIECE",
    categoryPath: null,
    pricesIncludeTax: true,
    trackStock: true,
    taxClassificationCode: null,
    isActive: true,
  };
  const variant = (over: Partial<ExportVariant>): ExportVariant => ({
    name: null,
    sku: null,
    pluCode: null,
    barcodes: [],
    option1: null,
    option2: null,
    option3: null,
    price: 0n,
    cost: 0n,
    isActive: true,
    ...over,
  });
  const products: ExportProduct[] = [
    {
      ...base,
      id: "talh",
      name: "Талх",
      description: "Шинэхэн талх",
      categoryPath: null,
      taxClassName: "",
      optionNames: [],
      variants: [
        variant({ sku: "TALH-1", barcodes: ["8650001000015"], price: 250000n, cost: 150000n }),
      ],
    },
    {
      ...base,
      id: "tsamts",
      name: "Цамц",
      categoryPath: null,
      taxClassName: "",
      optionNames: ["Хэмжээ"],
      variants: [
        variant({ sku: "TS-S", option1: "S", price: 2500000n, cost: 1200000n }),
        variant({ sku: "TS-M", option1: "M", price: 2500000n, cost: 1200000n }),
      ],
    },
  ];
  return CSV_BOM + csvHeader(withCosts) + products.map((p) => productToCsv(p, withCosts)).join("");
}

// ── Row parsing and validation ────────────────────────────────────────────

export interface CatalogCsvRow {
  line: number;
  productKey: string | undefined;
  name: string;
  description: string | undefined;
  type: (typeof PRODUCT_TYPES)[number] | undefined;
  unit: (typeof UNITS)[number] | undefined;
  category: string | undefined;
  taxClass: string | undefined;
  pricesIncludeTax: boolean | undefined;
  trackStock: boolean | undefined;
  taxClassificationCode: string | undefined;
  productActive: boolean | undefined;
  optionNames: (string | undefined)[];
  variantName: string | undefined;
  sku: string | undefined;
  plu: string | undefined;
  barcodes: string[];
  options: (string | undefined)[];
  price: bigint | undefined;
  cost: bigint | undefined;
  variantActive: boolean | undefined;
}

export interface ParsedCatalogCsv {
  rows: CatalogCsvRow[];
  issues: ImportIssue[];
}

const TRUE_WORDS = new Set(["true", "1", "yes", "y"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n"]);

function firstCode(error: z.ZodError): ImportIssueCode {
  const message = error.issues[0]?.message;
  return (VALIDATION_CODES as readonly string[]).includes(message ?? "")
    ? (message as ValidationCode)
    : "invalid";
}

/** A header cell → known column, case-insensitively. */
function columnOf(cell: string): CsvColumn | null {
  const key = cell.trim().toLowerCase();
  return (CSV_COLUMNS as readonly string[]).includes(key) ? (key as CsvColumn) : null;
}

/** Parse and validate the cells of every row. Pure: no database access. */
export function parseCatalogCsv(
  text: string,
  options: { allowCost?: boolean } = {},
): ParsedCatalogCsv {
  const fail = (code: ImportIssueCode): ParsedCatalogCsv => ({
    rows: [],
    issues: [{ line: 0, column: null, code }],
  });
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) return fail("tooLarge");
  if (text.includes("�")) return fail("badEncoding");

  const { records, issues } = parseCsv(text);
  if (issues.some((i) => i.code === "unterminatedQuote")) return { rows: [], issues };
  const [headerRecord, ...dataRecords] = records;
  if (!headerRecord) return fail("empty");
  if (dataRecords.length === 0) return { rows: [], issues: [...issues, ...fail("empty").issues] };
  if (dataRecords.length > MAX_IMPORT_ROWS) return fail("tooManyRows");

  const headerIssues: ImportIssue[] = [];
  const index = new Map<CsvColumn, number>();
  headerRecord.cells.forEach((cell, position) => {
    const column = columnOf(unescapeCell(cell));
    if (!column) {
      headerIssues.push({ line: headerRecord.line, column: null, code: "unknownColumn" });
    } else if (index.has(column)) {
      headerIssues.push({ line: headerRecord.line, column, code: "duplicateColumn" });
    } else {
      index.set(column, position);
    }
  });
  for (const required of REQUIRED_COLUMNS) {
    if (!index.has(required)) {
      headerIssues.push({ line: headerRecord.line, column: required, code: "missingColumn" });
    }
  }
  if (headerIssues.length > 0) return { rows: [], issues: [...issues, ...headerIssues] };

  const rows: CatalogCsvRow[] = [];
  for (const record of dataRecords) {
    if (record.cells.length !== headerRecord.cells.length) {
      issues.push({ line: record.line, column: null, code: "columnCount" });
      continue;
    }
    const row = parseRow(record, index, options.allowCost ?? false, issues);
    if (row) rows.push(row);
  }
  issues.push(...duplicateCodeIssues(rows));
  return { rows, issues };
}

/** Trim, and drop the apostrophe `escapeFormula` added. */
function unescapeCell(raw: string): string {
  const trimmed = raw.trim();
  return ESCAPED_FORMULA.test(trimmed) ? trimmed.slice(1) : trimmed;
}

function parseRow(
  record: CsvRecord,
  index: Map<CsvColumn, number>,
  allowCost: boolean,
  issues: ImportIssue[],
): CatalogCsvRow | null {
  const line = record.line;
  let valid = true;
  const flag = (column: CsvColumn, code: ImportIssueCode) => {
    issues.push({ line, column, code });
    valid = false;
  };
  /** Cell text, or undefined when the column is absent or blank. */
  const cell = (column: CsvColumn): string | undefined => {
    const position = index.get(column);
    if (position === undefined) return undefined;
    const value = unescapeCell(record.cells[position] ?? "");
    return value === "" ? undefined : value;
  };
  const text = (column: CsvColumn, schema: z.ZodType<string | null>): string | undefined => {
    const raw = cell(column);
    if (raw === undefined) return undefined;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      flag(column, firstCode(parsed.error));
      return undefined;
    }
    return parsed.data ?? undefined;
  };
  const bool = (column: CsvColumn): boolean | undefined => {
    const raw = cell(column)?.toLowerCase();
    if (raw === undefined) return undefined;
    if (TRUE_WORDS.has(raw)) return true;
    if (FALSE_WORDS.has(raw)) return false;
    flag(column, "invalidBool");
    return undefined;
  };
  const oneOf = <T extends string>(column: CsvColumn, allowed: readonly T[]): T | undefined => {
    const raw = cell(column)?.toUpperCase();
    if (raw === undefined) return undefined;
    const match = allowed.find((value) => value === raw);
    if (!match) flag(column, "invalidEnum");
    return match;
  };
  const money = (column: CsvColumn): bigint | undefined => {
    const raw = cell(column);
    if (raw === undefined) return undefined;
    const parsed = moneyField.safeParse(raw);
    if (!parsed.success) {
      flag(column, "invalidMoney");
      return undefined;
    }
    return parsed.data;
  };

  const name = cell("name");
  if (name === undefined) flag("name", "required");
  else if (!requiredText(160).safeParse(name).success) flag("name", "tooLong");

  const category = text("category", z.string().max(200, "tooLong"));
  const taxClass = text("tax_class", z.string().max(60, "tooLong"));
  const barcodes: string[] = [];
  const rawBarcodes = cell("barcodes");
  if (rawBarcodes !== undefined) {
    for (const part of rawBarcodes.split(BARCODE_SEPARATOR)) {
      const code = part.trim();
      if (code === "") continue;
      const parsed = barcodeField.safeParse(code);
      if (parsed.success) barcodes.push(parsed.data);
      else flag("barcodes", "invalidBarcode");
    }
    if (barcodes.length > MAX_BARCODES_PER_VARIANT) flag("barcodes", "tooLong");
  }
  // A blank price is allowed here (a matched variant keeps its price); the
  // importer reports `required` for new variants.
  const price = money("price");
  const cost = money("cost");
  if (cost !== undefined && !allowCost) flag("cost", "costNotAllowed");

  const optionName = (column: CsvColumn) => text(column, requiredText(40));
  const row: CatalogCsvRow = {
    line,
    productKey: text("product_key", z.string().max(64, "tooLong")),
    name: name ?? "",
    description: text("description", optionalText(2000)),
    type: oneOf("type", PRODUCT_TYPES),
    unit: oneOf("unit", UNITS),
    category,
    taxClass,
    pricesIncludeTax: bool("prices_include_tax"),
    trackStock: bool("track_stock"),
    taxClassificationCode: text("tax_classification_code", optionalText(32)),
    productActive: bool("product_active"),
    optionNames: [
      optionName("option1_name"),
      optionName("option2_name"),
      optionName("option3_name"),
    ],
    variantName: text("variant_name", optionalText(80)),
    sku: text("sku", skuField),
    plu: text("plu", pluField),
    barcodes,
    options: [
      text("option1", requiredText(40)),
      text("option2", requiredText(40)),
      text("option3", requiredText(40)),
    ],
    price,
    cost,
    variantActive: bool("variant_active"),
  };
  return valid ? row : null;
}

/** Codes may appear once in the whole file (SKU case-insensitively). */
function duplicateCodeIssues(rows: CatalogCsvRow[]): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const seen = { sku: new Set<string>(), plu: new Set<string>(), barcode: new Set<string>() };
  for (const row of rows) {
    if (row.sku) {
      const key = row.sku.toLowerCase();
      if (seen.sku.has(key))
        issues.push({ line: row.line, column: "sku", code: "duplicateInFile" });
      seen.sku.add(key);
    }
    if (row.plu) {
      if (seen.plu.has(row.plu)) {
        issues.push({ line: row.line, column: "plu", code: "duplicateInFile" });
      }
      seen.plu.add(row.plu);
    }
    let reported = false;
    for (const code of row.barcodes) {
      if (seen.barcode.has(code) && !reported) {
        issues.push({ line: row.line, column: "barcodes", code: "duplicateInFile" });
        reported = true;
      }
      seen.barcode.add(code);
    }
  }
  return issues;
}

// ── Grouping rows into products ───────────────────────────────────────────

export interface ProductGroup {
  /** The first row's values for the product-level columns. */
  head: CatalogCsvRow;
  rows: CatalogCsvRow[];
  optionNames: (string | undefined)[];
}

type ProductLevelKey =
  | "name"
  | "description"
  | "type"
  | "unit"
  | "category"
  | "taxClass"
  | "pricesIncludeTax"
  | "trackStock"
  | "taxClassificationCode"
  | "productActive";

const PRODUCT_LEVEL: [ProductLevelKey, CsvColumn][] = [
  ["name", "name"],
  ["description", "description"],
  ["type", "type"],
  ["unit", "unit"],
  ["category", "category"],
  ["taxClass", "tax_class"],
  ["pricesIncludeTax", "prices_include_tax"],
  ["trackStock", "track_stock"],
  ["taxClassificationCode", "tax_classification_code"],
  ["productActive", "product_active"],
];

const comparable = (value: unknown) =>
  typeof value === "string" ? value.toLowerCase() : (value as boolean | undefined);

/**
 * Group rows by product_key (else by name, case-insensitively). Rows of a
 * product must agree on every product-level column they fill in.
 */
export function groupCatalogRows(rows: CatalogCsvRow[]): {
  groups: ProductGroup[];
  issues: ImportIssue[];
} {
  const issues: ImportIssue[] = [];
  const byKey = new Map<string, CatalogCsvRow[]>();
  for (const row of rows) {
    const key = row.productKey
      ? `k:${row.productKey.toLowerCase()}`
      : `n:${row.name.toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const groups: ProductGroup[] = [];
  for (const members of byKey.values()) {
    const head = members[0]!;
    const merged = { ...head };
    for (const row of members.slice(1)) {
      for (const [key, column] of PRODUCT_LEVEL) {
        const value = row[key];
        if (value === undefined) continue;
        if (merged[key] === undefined) {
          (merged as Record<string, unknown>)[key] = value;
        } else if (comparable(merged[key]) !== comparable(value)) {
          issues.push({ line: row.line, column, code: "productConflict" });
        }
      }
    }
    const optionNames = [0, 1, 2].map((slot) => {
      const named = members.filter((m) => m.optionNames[slot] !== undefined);
      const first = named[0]?.optionNames[slot];
      for (const row of named.slice(1)) {
        if (row.optionNames[slot]!.toLowerCase() !== first!.toLowerCase()) {
          issues.push({
            line: row.line,
            column: (["option1_name", "option2_name", "option3_name"] as const)[slot]!,
            code: "productConflict",
          });
        }
      }
      return first;
    });
    groups.push({ head: merged, rows: members, optionNames });
  }
  return { groups, issues };
}
