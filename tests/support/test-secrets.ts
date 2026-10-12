/**
 * Deterministic secrets for tests when the environment doesn't provide them
 * (CI sets real random values). Never used outside the test runner.
 */
import "dotenv/config";

process.env.AUTH_SECRET ??= "test-auth-secret-0123456789abcdefghijklmnop";
process.env.PIN_PEPPER ??= "test-pin-pepper-0123456789abcdefghijklmnopq";
process.env.GIFT_CARD_PEPPER ??= "test-giftcard-pepper-0123456789abcdefghijk";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/pos_test";
