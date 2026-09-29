import { createRequire } from "node:module";
import { type AuthSetupContext, BackendAdapter } from "@parcae/backend";
import { Model } from "@parcae/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({ users: { getUser: mocks.getUser } }),
  verifyToken: mocks.verifyToken,
}));

import { clerk } from "../index.js";

const url = process.env.PARCAE_TEST_DATABASE_URL;

// knex is a dependency of @parcae/backend, not of this package.
const knexFactory = createRequire(import.meta.resolve("@parcae/backend"))(
  "knex",
);

class User extends Model {
  static type = "user" as const;
  name = "";
  email = "";
  image = "";
}

User.__schema = { name: "string", email: "string", image: "string" };

// The unit suite's adapter fake saves anything it is handed, which hid a
// first-seen user being saved as an update of a row that did not exist.
// Only the real BackendAdapter enforces the insert-versus-update contract.
(url ? describe : describe.skip)("clerk provisioning against Postgres", () => {
  const schema = `parcae_clerk_${Date.now().toString(36)}`;
  // biome-ignore lint/suspicious/noExplicitAny: knex resolved at runtime
  let admin: any;
  // biome-ignore lint/suspicious/noExplicitAny: knex resolved at runtime
  let db: any;

  beforeEach(async () => {
    admin = knexFactory({ client: "pg", connection: url, pool: { min: 0, max: 1 } });
    await admin.raw("CREATE SCHEMA ??", [schema]);
    db = knexFactory({
      client: "pg",
      connection: url,
      searchPath: [schema],
      pool: { min: 0, max: 2 },
    });
    // biome-ignore lint/suspicious/noExplicitAny: knex table builder
    await db.schema.createTable("users", (table: any) => {
      table.string("id").primary();
      table.string("name");
      table.string("email");
      table.string("image");
      table.dateTime("createdAt");
      table.dateTime("updatedAt");
      table.string("tmp");
      table.jsonb("data");
    });
    mocks.verifyToken.mockResolvedValue({ sub: "user_new" });
    mocks.getUser.mockResolvedValue({
      firstName: "Ada",
      lastName: "Lovelace",
      imageUrl: "",
      primaryEmailAddressId: "email_1",
      emailAddresses: [{ id: "email_1", emailAddress: "ada@example.com" }],
    });
  });

  afterEach(async () => {
    await db.destroy();
    await admin.raw("DROP SCHEMA ?? CASCADE", [schema]);
    await admin.destroy();
  });

  it("creates the local user the first time a Clerk user's token is seen", async () => {
    const auth = clerk({ secretKey: "sk_test", publishableKey: "pk_test" });
    await auth.setup({
      userModel: User,
      adapter: new BackendAdapter({ read: db, write: db }),
      config: {},
      db,
    } as unknown as AuthSetupContext);

    await expect(auth.resolveToken("token")).resolves.toEqual({
      user: { id: "user_new" },
    });
    expect(await db("users").where("id", "user_new").first()).toMatchObject({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
  });
});
