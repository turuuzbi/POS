import "server-only";
import { createConsoleMessaging } from "./console-mock";
import type { MessagingProvider } from "./types";

export type { MessageChannel, MessagingProvider } from "./types";

let provider: MessagingProvider | undefined;

/** TODO: select a real SMS gateway / SMTP adapter by env when one is chosen. */
export function getMessagingProvider(): MessagingProvider {
  return (provider ??= createConsoleMessaging());
}

export function setMessagingProviderForTests(next: MessagingProvider | null): void {
  provider = next ?? undefined;
}
