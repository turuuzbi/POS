import "server-only";
import { createMockEbarimtProvider } from "./mock-ebarimt";
import type { FiscalProvider } from "./types";

export type { FiscalProvider } from "./types";

let provider: FiscalProvider | undefined;

/** The configured fiscal provider. TODO(ebarimt): select the real adapter by env once confirmed. */
export function getFiscalProvider(): FiscalProvider {
  return (provider ??= createMockEbarimtProvider());
}

export function setFiscalProviderForTests(next: FiscalProvider | null): void {
  provider = next ?? undefined;
}
