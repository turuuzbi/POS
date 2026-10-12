import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Guard rail: every server action must go through defineAction /
 * definePublicAction (validation + authorisation + safe errors). Directives
 * are found with the TypeScript parser, so comments or formatting can't hide
 * an inline "use server" function.
 */
const SRC = join(__dirname, "..", "..");
const GENERATED = join(SRC, "generated");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return path === GENERATED ? [] : sourceFiles(path);
    return /\.(m?[jt]sx?)$/.test(entry) && !/\.test\.[jt]sx?$/.test(entry) ? [path] : [];
  });
}

function hasUseServer(statements: ts.NodeArray<ts.Statement>): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use server") return true;
  }
  return false;
}

interface Analysis {
  path: string;
  moduleLevel: boolean;
  inlineCount: number;
  exports: string[];
}

function analyse(path: string): Analysis {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let inlineCount = 0;
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) &&
      node.body &&
      ts.isBlock(node.body) &&
      hasUseServer(node.body.statements)
    ) {
      inlineCount++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const exports: string[] = [];
  for (const statement of file.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const exported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      exports.push(`unsupported: ${statement.getText(file).slice(0, 60)}`);
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        const callee =
          init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)
            ? init.expression.text
            : "something else";
        exports.push(callee);
      }
    } else if (exported) {
      exports.push(`unsupported: ${ts.SyntaxKind[statement.kind]}`);
    }
  }
  return {
    path: relative(SRC, path),
    moduleLevel: hasUseServer(file.statements),
    inlineCount,
    exports,
  };
}

const analyses = sourceFiles(SRC).map(analyse);

describe("server actions", () => {
  const serverModules = analyses.filter((a) => a.moduleLevel);

  it("exist only under src/server/actions", () => {
    expect(serverModules.length).toBeGreaterThan(0);
    for (const { path } of serverModules)
      expect(path.startsWith("server/actions/"), path).toBe(true);
  });

  it("never use inline 'use server' functions", () => {
    for (const { path, inlineCount } of analyses) expect(inlineCount, path).toBe(0);
  });

  it("export only defineAction / definePublicAction results", () => {
    for (const { path, exports } of serverModules) {
      expect(exports.length, path).toBeGreaterThan(0);
      for (const callee of exports) {
        expect(["defineAction", "definePublicAction"], `${path}: ${callee}`).toContain(callee);
      }
    }
  });

  it("detects directives that carry comments (self-test)", () => {
    const sample = ts.createSourceFile(
      "x.ts",
      'export async function f() { "use server"; // note\n return 1 }',
      ts.ScriptTarget.Latest,
      true,
    );
    const fn = sample.statements[0] as ts.FunctionDeclaration;
    expect(hasUseServer(fn.body!.statements)).toBe(true);
  });
});
