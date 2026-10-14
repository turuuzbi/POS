import { describe, expect, it } from "vitest";
import mn from "../../messages/mn/importExport.json";
import en from "../../messages/en/importExport.json";
import {
  CSV_BOM,
  CSV_COLUMNS,
  IMPORT_ISSUE_CODES,
  MAX_IMPORT_ROWS,
  csvField,
  csvHeader,
  csvText,
  escapeFormula,
  formatCsvMoney,
  groupCatalogRows,
  parseCatalogCsv,
  parseCsv,
  productToCsv,
  templateCsv,
  type ExportProduct,
} from "./csv-catalog";

const cells = (text: string) => parseCsv(text).records.map((r) => r.cells);

describe("parseCsv", () => {
  it("parses simple records with LF, CRLF and lone CR", () => {
    expect(cells("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(cells("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(cells("a,b\rc,d\r")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("strips a UTF-8 BOM", () => {
    expect(cells(`${CSV_BOM}name,price\nx,1`)[0]).toEqual(["name", "price"]);
  });

  it("handles quotes, escaped quotes, commas and newlines inside fields", () => {
    expect(cells('"a,b","say ""hi""","line1\r\nline2"\n')).toEqual([
      ["a,b", 'say "hi"', "line1\r\nline2"],
    ]);
  });

  it("keeps empty cells and empty quoted cells", () => {
    expect(cells('a,,"",d')).toEqual([["a", "", "", "d"]]);
  });

  it("skips blank lines but not a quoted empty record", () => {
    expect(cells("a\n\n\nb\n")).toEqual([["a"], ["b"]]);
    expect(cells('a\n""\nb')).toEqual([["a"], [""], ["b"]]);
  });

  it("reports the physical line a record starts on", () => {
    const { records } = parseCsv('h1,h2\n"multi\nline",x\n\nlast,row');
    expect(records.map((r) => r.line)).toEqual([1, 2, 5]);
    const crlf = parseCsv('h\r\n"a\r\nb"\r\nz');
    expect(crlf.records.map((r) => r.line)).toEqual([1, 2, 4]);
  });

  it("reads Mongolian text unchanged", () => {
    expect(cells("Цамц,“Хөх”,Өндөр\n")).toEqual([["Цамц", "“Хөх”", "Өндөр"]]);
  });

  it("flags unterminated and misplaced quotes", () => {
    expect(parseCsv('a,"b\nc').issues).toEqual([
      { line: 1, column: null, code: "unterminatedQuote" },
    ]);
    expect(parseCsv('"a"x,b').issues[0]?.code).toBe("badQuote");
  });

  it("keeps a stray quote inside an unquoted field literally", () => {
    expect(cells('5" nail,x')).toEqual([['5" nail', "x"]]);
  });

  it("handles a file without a trailing newline and an empty file", () => {
    expect(cells("a,b")).toEqual([["a", "b"]]);
    expect(cells("")).toEqual([]);
  });
});

describe("serializer", () => {
  it("quotes only when needed", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField(" padded")).toBe('" padded"');
  });

  it("neutralises spreadsheet formulas", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      expect(escapeFormula(bad)).toBe(`'${bad}`);
    }
    expect(escapeFormula("safe=1")).toBe("safe=1");
    expect(csvText('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvText(null)).toBe("");
  });

  it("formats money without grouping", () => {
    expect(formatCsvMoney(0n)).toBe("0");
    expect(formatCsvMoney(2500000n)).toBe("25000");
    expect(formatCsvMoney(1234550n)).toBe("12345.5".replace(".5", ".50"));
    expect(formatCsvMoney(5n)).toBe("0.05");
  });

  it("omits the cost column unless allowed", () => {
    expect(csvHeader(false)).not.toContain("cost");
    expect(csvHeader(true)).toContain(",cost,");
  });

  it("template is parseable by the importer", () => {
    for (const withCosts of [true, false]) {
      const parsed = parseCatalogCsv(templateCsv(withCosts), { allowCost: withCosts });
      expect(parsed.issues).toEqual([]);
      expect(parsed.rows.length).toBe(3);
    }
  });
});

const product: ExportProduct = {
  id: "0199-product",
  name: '=Цамц, "Хөх"\nшинэ',
  description: "+тайлбар",
  type: "STANDARD",
  unit: "PIECE",
  categoryPath: "Хувцас > Эрэгтэй",
  taxClassName: "НӨАТ 10%",
  pricesIncludeTax: true,
  trackStock: true,
  taxClassificationCode: null,
  isActive: true,
  optionNames: ["Хэмжээ"],
  variants: [
    {
      name: null,
      sku: "TS-S",
      pluCode: "12",
      barcodes: ["8650001000015", "-4321"],
      option1: "S",
      option2: null,
      option3: null,
      price: 2500050n,
      cost: 1200000n,
      isActive: true,
    },
    {
      name: "Том",
      sku: null,
      pluCode: null,
      barcodes: [],
      option1: "M",
      option2: null,
      option3: null,
      price: 3000000n,
      cost: 0n,
      isActive: false,
    },
  ],
};

describe("export then import round trip", () => {
  it("survives quotes, newlines, formulas and Mongolian text", () => {
    const text = CSV_BOM + csvHeader(true) + productToCsv(product, true);
    const parsed = parseCatalogCsv(text, { allowCost: true });
    expect(parsed.issues).toEqual([]);
    const [first, second] = parsed.rows;
    expect(first).toMatchObject({
      productKey: "0199-product",
      name: product.name,
      description: "+тайлбар",
      category: "Хувцас > Эрэгтэй",
      taxClass: "НӨАТ 10%",
      sku: "TS-S",
      plu: "12",
      barcodes: ["8650001000015", "-4321"],
      price: 2500050n,
      cost: 1200000n,
      pricesIncludeTax: true,
    });
    expect(first?.optionNames[0]).toBe("Хэмжээ");
    expect(second).toMatchObject({ variantName: "Том", variantActive: false, price: 3000000n });
  });

  it("never emits a cell that starts like a formula", () => {
    const text = productToCsv(product, true);
    for (const record of parseCsv(text).records) {
      for (const cell of record.cells) expect(/^[=+\-@\t\r]/.test(cell)).toBe(false);
    }
  });

  it("groups the rows of a product", () => {
    const parsed = parseCatalogCsv(csvHeader(true) + productToCsv(product, true), {
      allowCost: true,
    });
    const { groups, issues } = groupCatalogRows(parsed.rows);
    expect(issues).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows).toHaveLength(2);
  });
});

const HEADER = "name,sku,barcodes,price,cost\r\n";

describe("parseCatalogCsv", () => {
  it("handles CRLF files from Excel with a BOM", () => {
    const parsed = parseCatalogCsv(`${CSV_BOM}${HEADER}Талх,TALH,8650001000015,2500,\r\n`);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({ name: "Талх", sku: "TALH", price: 250000n, line: 2 });
  });

  it("rejects empty and header-only files", () => {
    expect(parseCatalogCsv("").issues[0]?.code).toBe("empty");
    expect(parseCatalogCsv(HEADER).issues[0]?.code).toBe("empty");
  });

  it("validates the header", () => {
    expect(parseCatalogCsv("name,price,price\nx,1").issues.map((i) => i.code)).toEqual([
      "duplicateColumn",
    ]);
    expect(parseCatalogCsv("name,bogus\nx,1").issues.map((i) => i.code)).toEqual([
      "unknownColumn",
      "missingColumn",
    ]);
    expect(parseCatalogCsv("sku\nx").issues[0]).toMatchObject({ code: "missingColumn" });
  });

  it("matches header names case-insensitively", () => {
    expect(parseCatalogCsv("Name, PRICE \nx,10").issues).toEqual([]);
  });

  it("reports row errors with line numbers and columns", () => {
    const { issues, rows } = parseCatalogCsv(
      `${HEADER}ok,A1,,10,\r\n,A2,,10,\r\nbad price,A3,,abc,\r\nbad code,A4,12,10,\r\nshort\r\n`,
    );
    expect(rows.map((r) => r.line)).toEqual([2]);
    expect(issues).toEqual(
      expect.arrayContaining([
        { line: 3, column: "name", code: "required" },
        { line: 4, column: "price", code: "invalidMoney" },
        { line: 5, column: "barcodes", code: "invalidBarcode" },
        { line: 6, column: null, code: "columnCount" },
      ]),
    );
  });

  it("points at the line a multi-line record starts on", () => {
    const { issues } = parseCatalogCsv('name,price\r\n"a\r\nb",1\r\nc,zzz\r\n');
    expect(issues).toEqual([{ line: 4, column: "price", code: "invalidMoney" }]);
  });

  it("rejects duplicate SKU, PLU and barcodes within the file", () => {
    const text =
      "name,sku,plu,barcodes,price\n" +
      "a,X1,5,8650001000015,1\n" +
      "b,x1,6,,1\n" +
      "c,Y,005,,1\n" +
      "d,Z,,8650001000015;8650001000015,1\n";
    const { issues } = parseCatalogCsv(text);
    expect(issues).toEqual([
      { line: 3, column: "sku", code: "duplicateInFile" },
      { line: 4, column: "plu", code: "duplicateInFile" },
      { line: 5, column: "barcodes", code: "duplicateInFile" },
    ]);
  });

  it("enforces row and size limits", () => {
    const many = "name,price\n" + "x,1\n".repeat(MAX_IMPORT_ROWS + 1);
    expect(parseCatalogCsv(many).issues[0]?.code).toBe("tooManyRows");
    expect(parseCatalogCsv("name,price\n" + "x,1\n".repeat(MAX_IMPORT_ROWS)).issues).toEqual([]);
    const big = "name,price\n" + "ж".repeat(1_100_000) + ",1\n";
    expect(parseCatalogCsv(big).issues[0]?.code).toBe("tooLarge");
  });

  it("rejects text that is not UTF-8", () => {
    expect(parseCatalogCsv("name,price\n�,1").issues[0]?.code).toBe("badEncoding");
  });

  it("parses booleans, enums and splits barcodes", () => {
    const { rows, issues } = parseCatalogCsv(
      "name,price,type,unit,track_stock,prices_include_tax,barcodes\n" +
        'x,"1,250.50",service,kg,No,1,"8650001000015; 4321 ;"\n',
    );
    expect(issues).toEqual([]);
    expect(rows[0]).toMatchObject({
      type: "SERVICE",
      unit: "KG",
      trackStock: false,
      pricesIncludeTax: true,
      price: 125050n,
      barcodes: ["8650001000015", "4321"],
    });
    const bad = parseCatalogCsv("name,price,type,track_stock\nx,1,foo,maybe\n");
    expect(bad.issues).toEqual([
      { line: 2, column: "type", code: "invalidEnum" },
      { line: 2, column: "track_stock", code: "invalidBool" },
    ]);
  });

  it("refuses costs for users without the permission", () => {
    const text = "name,price,cost\nx,1,5\ny,2,\n";
    expect(parseCatalogCsv(text, { allowCost: false }).issues).toEqual([
      { line: 2, column: "cost", code: "costNotAllowed" },
    ]);
    expect(parseCatalogCsv(text, { allowCost: true }).issues).toEqual([]);
  });

  it("strips the formula-protection apostrophe", () => {
    const { rows } = parseCatalogCsv("name,price\n'=SUM(1),1\n'plain,2\n");
    expect(rows.map((r) => r.name)).toEqual(["=SUM(1)", "'plain"]);
  });
});

describe("groupCatalogRows", () => {
  it("groups by product_key, else by name, case-insensitively", () => {
    const { rows } = parseCatalogCsv("product_key,name,price\nk1,A,1\nk1,A,2\n,B,3\n,b,4\n,C,5\n");
    const { groups, issues } = groupCatalogRows(rows);
    expect(issues).toEqual([]);
    expect(groups.map((g) => g.rows.length)).toEqual([2, 2, 1]);
  });

  it("flags conflicting product-level values and fills gaps from other rows", () => {
    const { rows } = parseCatalogCsv(
      "name,type,unit,price\nA,STANDARD,,1\nA,SERVICE,KG,2\nA,,PIECE,3\n",
    );
    const { groups, issues } = groupCatalogRows(rows);
    expect(issues).toEqual([
      { line: 3, column: "type", code: "productConflict" },
      { line: 4, column: "unit", code: "productConflict" },
    ]);
    expect(groups[0]?.head.unit).toBe("KG");
  });
});

describe("messages", () => {
  it("has a translation for every issue code in both languages", () => {
    for (const messages of [mn, en]) {
      for (const code of IMPORT_ISSUE_CODES) {
        expect(messages.codes[code as keyof typeof messages.codes], code).toBeTruthy();
      }
    }
  });

  it("knows every column", () => {
    expect(new Set(CSV_COLUMNS).size).toBe(CSV_COLUMNS.length);
  });
});
