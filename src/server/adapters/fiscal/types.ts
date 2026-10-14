/**
 * Fiscal (eBarimt) provider. Nothing about the real PosAPI is guessed here.
 *
 * TODO(ebarimt): confirm with the real PosAPI contract before wiring it up:
 *   - branch / POS registration (Location.fiscalConfig) and merchant TIN,
 *   - item classification codes (Product.taxClassificationCode),
 *   - receipt type (B2C / B2B by buyerTaxId), tax-type codes per TaxClass,
 *   - payload and response mapping, lottery and QR fields,
 *   - return/cancel semantics (issueReturn) and status polling.
 */

export interface FiscalLine {
  name: string;
  sku: string | null;
  qtyMilli: number;
  unitPrice: bigint;
  /** TODO(ebarimt): classification code, once the code list is confirmed. */
  classificationCode?: string | null;
  net: bigint;
  vat: bigint;
  cityTax: bigint;
  total: bigint;
}

export interface FiscalSaleRequest {
  saleId: string;
  receiptNumber: string;
  issuedAt: Date;
  /** B2B buyer registration number. */
  buyerTaxId?: string | null;
  lines: FiscalLine[];
  net: bigint;
  vat: bigint;
  cityTax: bigint;
  /** What the customer paid (payable). */
  total: bigint;
  payments: { method: string; amount: bigint }[];
}

export interface FiscalReturnRequest {
  refundId: string;
  /** External id of the receipt being reversed. */
  originalExternalId: string;
  receiptNumber: string;
  issuedAt: Date;
  total: bigint;
}

export interface FiscalIssueResult {
  externalId: string;
  lotteryCode?: string;
  qrData?: string;
  raw: Record<string, unknown>;
}

export interface FiscalStatusResult {
  status: "PENDING" | "ISSUED" | "FAILED" | "CANCELLED";
  raw: Record<string, unknown>;
}

export interface FiscalProvider {
  /** Stored in FiscalReceipt.provider. */
  readonly name: string;
  issue(request: FiscalSaleRequest): Promise<FiscalIssueResult>;
  issueReturn(request: FiscalReturnRequest): Promise<FiscalIssueResult>;
  status(externalId: string): Promise<FiscalStatusResult>;
}
