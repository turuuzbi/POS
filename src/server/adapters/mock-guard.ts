import "server-only";

/**
 * Mock providers (QPay, eBarimt) must never run unnoticed in production: a
 * mock fiscal receipt was filed with nobody, and a mock QPay invoice can
 * "receive" money that never arrived. They are available in development and
 * tests, and in a production build only when ALLOW_MOCK_PROVIDERS=1 is set
 * on purpose (staging, production-build e2e). Everything else fails closed.
 */
export class ProviderConfigurationError extends Error {
  constructor(provider: string) {
    super(
      `The ${provider} provider is not configured: mock providers are disabled in production. ` +
        "Configure a real adapter (staging/e2e only: set ALLOW_MOCK_PROVIDERS=1).",
    );
    this.name = "ProviderConfigurationError";
  }
}

export function mockProvidersAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" || env.ALLOW_MOCK_PROVIDERS === "1";
}

export function assertMockProvidersAllowed(provider: string): void {
  if (!mockProvidersAllowed()) throw new ProviderConfigurationError(provider);
}
