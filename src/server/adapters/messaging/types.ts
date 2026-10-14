export type MessageChannel = "SMS" | "EMAIL";

export interface OutgoingMessage {
  channel: MessageChannel;
  /** Phone number (SMS) or e-mail address. */
  destination: string;
  subject?: string;
  body: string;
}

export interface SentMessage {
  providerRef: string;
}

/** SMS / e-mail transport. Throw to signal a failed send (the caller records it). */
export interface MessagingProvider {
  readonly name: string;
  send(message: OutgoingMessage): Promise<SentMessage>;
}
