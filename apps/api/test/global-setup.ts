// Creates a fresh, migrated `founder_signal_test_api` database before the suite.
import { createTestDatabase } from "@fs/db/testing";

export default async function setup() {
  process.env.TEST_DATABASE_URL = await createTestDatabase("founder_signal_test_api");
}
