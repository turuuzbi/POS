import "./test-secrets";
import { testDatabaseUrl } from "./test-database";

// Point every Prisma client created in tests at the test database.
process.env.DATABASE_URL = testDatabaseUrl();
