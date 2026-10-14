/** What the client needs to show a QPay invoice. */
export interface QpayInvoice {
  intentId: string;
  qrText: string;
  deeplinks: { name: string; link: string }[];
  expiresAt: string | null;
}

export type QpayStatus = "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "CANCELLED";
