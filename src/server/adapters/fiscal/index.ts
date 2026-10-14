import "server-only";
import { assertMockProvidersAllowed } from "../mock-guard";
import { createMockEbarimtProvider } from "./mock-ebarimt";
import type { FiscalProvider } from "./types";

export type { FiscalProvider } from "./types";

let override: FiscalProvider | undefined;
let mock: FiscalProvider | undefined;

/**
 * The configured fiscal provider. Only the mock exists today, and it fails
 * closed in production unless ALLOW_MOCK_PROVIDERS=1 (see mock-guard.ts).
 * TODO(ebarimt): select the real adapter by env once confirmed.
 */
export function getFiscalProvider(): FiscalProvider {
  if (override) return override;
  assertMockProvidersAllowed("fiscal (eBarimt)");
  return (mock ??= createMockEbarimtProvider());
}

export function setFiscalProviderForTests(next: FiscalProvider | null): void {
  override = next ?? undefined;
}
