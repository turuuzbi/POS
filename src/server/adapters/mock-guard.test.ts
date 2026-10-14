import { afterEach, describe, expect, it, vi } from "vitest";
import { getFiscalProvider, setFiscalProviderForTests } from "./fiscal";
import { getPaymentProvider, markMockInvoicePaid, setPaymentProviderForTests } from "./payments";
import { createMockQpayProvider } from "./payments/mock-qpay";
import { mockProvidersAllowed, ProviderConfigurationError } from "./mock-guard";

afterEach(() => {
  vi.unstubAllEnvs();
  setFiscalProviderForTests(null);
  setPaymentProviderForTests(null);
});

describe("mock providers fail closed", () => {
  it("are allowed outside production and in production only with ALLOW_MOCK_PROVIDERS=1", () => {
    expect(mockProvidersAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(mockProvidersAllowed({ NODE_ENV: "test" })).toBe(true);
    expect(mockProvidersAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(mockProvidersAllowed({ NODE_ENV: "production", ALLOW_MOCK_PROVIDERS: "true" })).toBe(
      false,
    );
    expect(mockProvidersAllowed({ NODE_ENV: "production", ALLOW_MOCK_PROVIDERS: "1" })).toBe(true);
  });

  it("refuse to hand out a mock in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_MOCK_PROVIDERS", "");
    expect(() => getFiscalProvider()).toThrow(ProviderConfigurationError);
    expect(() => getPaymentProvider()).toThrow(/not configured/);
  });

  it("hand out the mocks in production when explicitly allowed", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_MOCK_PROVIDERS", "1");
    expect(getFiscalProvider().name).toBe("mock");
    expect(getPaymentProvider().name).toBe("mock");
  });

  it("ignore MOCK_QPAY_AUTOPAY_SECONDS and the mark-paid hook in production", async () => {
    vi.stubEnv("MOCK_QPAY_AUTOPAY_SECONDS", "0");
    const provider = createMockQpayProvider();
    const invoice = await provider.createInvoice({
      intentId: "i",
      saleId: "s",
      amount: 1000n,
      expiresInSeconds: 600,
    } as Parameters<typeof provider.createInvoice>[0]);
    expect((await provider.checkPayment(invoice.providerRef)).status).toBe("PAID");

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_MOCK_PROVIDERS", "");
    expect((await provider.checkPayment(invoice.providerRef)).status).toBe("PENDING");
    expect(markMockInvoicePaid(invoice.providerRef)).toBe(false);
    expect((await provider.checkPayment(invoice.providerRef)).status).toBe("PENDING");
  });
});
