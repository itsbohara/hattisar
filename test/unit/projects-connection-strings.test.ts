import { describe, expect, it } from "vitest";
import {
  MASK,
  ownerConnectionStrings,
  type ProjectEndpoint,
} from "../../src/projects/connection-strings.js";
import type { Box } from "../../src/registry/boxes.js";

type Endpoint = ProjectEndpoint & Pick<Box, "kind">;

const POOLER_HOST = "pool.example.com";

const registered: Endpoint = {
  kind: "registered",
  host: "db",
  adminUser: "admin",
  publicHost: "db.example.com",
  publicPort: 5433,
  sslmode: "disable",
  poolerTenant: "hattisar-b1",
  poolerSessionPort: 54322,
  poolerTransactionPort: 6543,
};

const shared: Endpoint = {
  kind: "shared",
  host: "db",
  adminUser: "admin",
  publicHost: "localhost",
  publicPort: 54322,
  sslmode: "disable",
  poolerTenant: "hattisar",
  poolerSessionPort: 54322,
  poolerTransactionPort: 6543,
};

const unpooled: Endpoint = {
  kind: "registered",
  host: "db",
  adminUser: "admin",
  publicHost: "pg.example.test",
  publicPort: 5433,
  sslmode: "disable",
  poolerTenant: null,
  poolerSessionPort: null,
  poolerTransactionPort: null,
};

const project = { dbName: "x", ownerRole: "hs_x_owner", kind: "created" as const };
const attached = { dbName: "x", ownerRole: "shop_app", kind: "attached" as const };

describe("ownerConnectionStrings", () => {
  it("offers session, transaction and direct strings for a box with a tenant", () => {
    expect(ownerConnectionStrings(registered, project, "pw", POOLER_HOST)).toEqual([
      {
        kind: "session",
        label: "Session pooler",
        url: "postgresql://hs_x_owner.hattisar-b1:pw@pool.example.com:54322/x",
        masked: `postgresql://hs_x_owner.hattisar-b1:${MASK}@pool.example.com:54322/x`,
      },
      {
        kind: "transaction",
        label: "Transaction pooler",
        url: "postgresql://hs_x_owner.hattisar-b1:pw@pool.example.com:6543/x",
        masked: `postgresql://hs_x_owner.hattisar-b1:${MASK}@pool.example.com:6543/x`,
      },
      {
        kind: "direct",
        label: "Direct",
        url: "postgresql://hs_x_owner:pw@db.example.com:5433/x",
        masked: `postgresql://hs_x_owner:${MASK}@db.example.com:5433/x`,
      },
    ]);
  });

  it("offers no direct string on the shared box", () => {
    const strings = ownerConnectionStrings(shared, project, "pw", POOLER_HOST);
    expect(strings.map(({ kind }) => kind)).toEqual(["session", "transaction"]);
    expect(strings[0]?.url).toBe("postgresql://hs_x_owner.hattisar:pw@pool.example.com:54322/x");
  });

  it("offers one direct string for a box without a tenant", () => {
    expect(ownerConnectionStrings(unpooled, project, "pw", POOLER_HOST)).toEqual([
      {
        kind: "direct",
        label: "Direct",
        url: "postgresql://hs_x_owner:pw@pg.example.test:5433/x",
        masked: `postgresql://hs_x_owner:${MASK}@pg.example.test:5433/x`,
      },
    ]);
  });

  it("never puts the password in a masked string", () => {
    for (const box of [registered, shared, unpooled]) {
      for (const { masked } of ownerConnectionStrings(box, project, "s3cret!", POOLER_HOST)) {
        expect(masked).not.toContain("s3cret");
        expect(masked).toContain(MASK);
      }
    }
  });

  it("carries the box's TLS mode into the direct string only", () => {
    const tls = { ...registered, sslmode: "require" };
    const strings = ownerConnectionStrings(tls, project, "pw", POOLER_HOST);
    expect(strings.map(({ url }) => url)).toEqual([
      "postgresql://hs_x_owner.hattisar-b1:pw@pool.example.com:54322/x",
      "postgresql://hs_x_owner.hattisar-b1:pw@pool.example.com:6543/x",
      "postgresql://hs_x_owner:pw@db.example.com:5433/x?sslmode=require",
    ]);
  });

  it("logs the owner in as <owner>.<project ref> through Supabase's pooler", () => {
    const pooler = "aws-0-us-east-1.pooler.supabase.com";
    const supabase = {
      ...unpooled,
      host: pooler,
      adminUser: "postgres.abcref",
      publicHost: pooler,
      publicPort: 5432,
      sslmode: "require",
    };
    const [string] = ownerConnectionStrings(supabase, project, "pw", POOLER_HOST);
    expect(string?.url).toBe(`postgresql://hs_x_owner.abcref:pw@${pooler}:5432/x?sslmode=require`);
  });

  it("URL-encodes the password", () => {
    const [string] = ownerConnectionStrings(unpooled, project, "a/b+c=d", POOLER_HOST);
    expect(string?.url).toBe("postgresql://hs_x_owner:a%2Fb%2Bc%3Dd@pg.example.test:5433/x");
  });

  it("offers one direct string with the login verbatim for an attached project", () => {
    expect(ownerConnectionStrings(registered, attached, "pw", POOLER_HOST)).toEqual([
      {
        kind: "direct",
        label: "Direct",
        url: "postgresql://shop_app:pw@db.example.com:5433/x",
        masked: `postgresql://shop_app:${MASK}@db.example.com:5433/x`,
      },
    ]);
  });

  it("keeps the sslmode rule and adds no pooler suffix for an attached project", () => {
    const supabase: Endpoint = {
      ...unpooled,
      host: "aws-0.pooler.supabase.com",
      adminUser: "postgres.abc",
      sslmode: "require",
    };
    const login = { ...attached, ownerRole: "postgres.abc" };
    expect(ownerConnectionStrings(supabase, login, "pw", POOLER_HOST)).toMatchObject([
      {
        kind: "direct",
        url: "postgresql://postgres.abc:pw@pg.example.test:5433/x?sslmode=require",
      },
    ]);
  });
});
