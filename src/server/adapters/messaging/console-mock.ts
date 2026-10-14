import "server-only";
import { randomUUID } from "node:crypto";
import type { MessagingProvider, OutgoingMessage, SentMessage } from "./types";

/** Writes the message to the server log instead of sending it. MOCK_MESSAGING_FAIL=1 fails every send. */
export function createConsoleMessaging(): MessagingProvider {
  return {
    name: "console",
    async send(message: OutgoingMessage): Promise<SentMessage> {
      if (process.env.MOCK_MESSAGING_FAIL === "1") throw new Error("mock messaging: unavailable");
      const providerRef = `console_${randomUUID()}`;
      if (process.env.NODE_ENV !== "test") {
        console.warn(
          `[messaging:${message.channel}] to=${message.destination} ref=${providerRef}\n${message.body}`,
        );
      }
      return { providerRef };
    },
  };
}
