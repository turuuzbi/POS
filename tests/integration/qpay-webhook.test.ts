import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markMockInvoicePaid, setPaymentProviderForTests } from "@/server/adapters/payments";
import type { PaymentProvider } from "@/server/adapters/payments/types";
import { createMockQpayProvider } from "@/server/adapters/payments/mock-qpay";
import { createQpayInvoice } from "@/server/services/payments";
import {
  handleQpayWebhookRequest,
  resetQpayWebhookThrottleForTests,
  WEBHOOK_LIMITS,
} from "@/server/services/qpay-webhook";
import { db, resetDatabase } from "../support/db";
import { createTill } from "../support/checkout-fixtures";

const SECRET = "test-qpay-webhook-secret";
const meta = { ip: null, userAgent: null };
const URL_BASE = "http://localhost/api/payments/qpay/webhook";

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_BASE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-secret": SECRET, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("QPay webhook endpoint", () => {
  let checks: string[];

  beforeEach(async () => {
    await resetDatabase();
    resetQpayWebhookThrottleForTests();
    vi.stubEnv("QPAY_WEBHOOK_SECRET", SECRET);
    const mock = createMockQpayProvider();
    checks = [];
    const spy: PaymentProvider = {
      ...mock,
      async checkPayment(ref) {
        checks.push(ref);
        return mock.checkPayment(ref);
      },
    };
    setPaymentProviderForTests(spy);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => {
    setPaymentProviderForTests(null);
    return db.$disconnect();
  });

  async function pendingIntent() {
    const till = await createTill();
    const { user, device } = till.ctx();
    const invoice = await createQpayInvoice(
      { saleId: uuidv7(), amount: 1000n },
      user,
      device,
      meta,
    );
    return db.paymentIntent.findUniqueOrThrow({ where: { id: invoice.intentId } });
  }

  it("rejects missing, wrong or unconfigured secrets without any provider call", async () => {
    const intent = await pendingIntent();
    const body = { providerRef: intent.providerRef };
    const noHeader = new Request(URL_BASE, { method: "POST", body: JSON.stringify(body) });
    expect((await handleQpayWebhookRequest(noHeader)).status).toBe(401);
    expect(
      (await handleQpayWebhookRequest(post(body, { "x-webhook-secret": "nope" }))).status,
    ).toBe(401);
    vi.stubEnv("QPAY_WEBHOOK_SECRET", "");
    expect((await handleQpayWebhookRequest(post(body))).status).toBe(401);
    expect(checks).toEqual([]);
  });

  it("accepts the secret as header, bearer token or token query param", async () => {
    const intent = await pendingIntent();
    const ref = intent.providerRef!;
    const viaQuery = new Request(`${URL_BASE}?token=${SECRET}&providerRef=${ref}`);
    expect((await handleQpayWebhookRequest(viaQuery)).status).toBe(200);
    const viaBearer = new Request(URL_BASE, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ providerRef: ref }),
    });
    expect((await handleQpayWebhookRequest(viaBearer)).status).toBe(200);
    expect(checks).toEqual([ref, ref]);
  });

  it("only asks the provider about PENDING intents that exist, with the same empty 200", async () => {
    const intent = await pendingIntent();
    const known = await handleQpayWebhookRequest(post({ providerRef: intent.providerRef }));
    const unknown = await handleQpayWebhookRequest(
      post({ providerRef: "mock_1_1234567890_deadbeef" }),
    );
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.text()).toBe("");
    expect(await unknown.text()).toBe("");
    expect(checks).toEqual([intent.providerRef]); // the unknown ref never reached the provider

    markMockInvoicePaid(intent.providerRef!);
    await handleQpayWebhookRequest(post({ providerRef: intent.providerRef }));
    expect((await db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe(
      "PAID",
    );
    checks.length = 0;
    await handleQpayWebhookRequest(post({ providerRef: intent.providerRef }));
    expect(checks).toEqual([]); // settled intents are not re-checked
  });

  it("ignores malformed payloads", async () => {
    for (const body of [
      "not json",
      "[]",
      "null",
      { providerRef: 42 },
      { providerRef: "a b" },
      {
        providerRef: "x".repeat(101),
      },
    ]) {
      const res = await handleQpayWebhookRequest(post(body));
      expect(res.status).toBe(200);
    }
    expect(checks).toEqual([]);
  });

  it("throttles repeated hits on one invoice", async () => {
    const intent = await pendingIntent();
    for (let i = 0; i < WEBHOOK_LIMITS.perRef + 5; i++) {
      await handleQpayWebhookRequest(post({ providerRef: intent.providerRef }), 1_000);
    }
    expect(checks).toHaveLength(WEBHOOK_LIMITS.perRef);
    // a new window lets it through again
    await handleQpayWebhookRequest(
      post({ providerRef: intent.providerRef }),
      1_000 + WEBHOOK_LIMITS.windowMs,
    );
    expect(checks).toHaveLength(WEBHOOK_LIMITS.perRef + 1);
  });

  it("throttles per client IP across different invoice ids", async () => {
    for (let i = 0; i < WEBHOOK_LIMITS.perIp + 10; i++) {
      await handleQpayWebhookRequest(
        post(
          { providerRef: `mock_1_1234567890_${i.toString(16).padStart(8, "0")}` },
          { "x-forwarded-for": "198.51.100.7" },
        ),
        5_000,
      );
    }
    // none exist, so no provider call either way; the IP counter is what we assert next
    const intent = await pendingIntent();
    await handleQpayWebhookRequest(
      post({ providerRef: intent.providerRef }, { "x-forwarded-for": "198.51.100.7" }),
      5_000,
    );
    expect(checks).toEqual([]); // throttled IP
    await handleQpayWebhookRequest(
      post({ providerRef: intent.providerRef }, { "x-forwarded-for": "198.51.100.8" }),
      5_000,
    );
    expect(checks).toEqual([intent.providerRef]);
  });
});
