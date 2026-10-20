import { describe, expect, it } from "vitest";
import {
  MASK,
  ownerConnectionStrings,
  type ProjectEndpoint,
} from "../../src/projects/connection-strings.js";

const pooled: ProjectEndpoint = {
  publicHost: "db.example.test",
  publicPort: 54322,
  poolerTenant: "hattisar",
  poolerSessionPort: 54322,
  poolerTransactionPort: 6543,
};

const direct: ProjectEndpoint = {
  publicHost: "pg.example.test",
  publicPort: 5433,
  poolerTenant: null,
  poolerSessionPort: null,
  poolerTransactionPort: null,
};

const project = { dbName: "my_app", ownerRole: "hs_my_app_owner" };

describe("ownerConnectionStrings", () => {
  it("offers session and transaction pooler strings with <owner>.<tenant>", () => {
    expect(ownerConnectionStrings(pooled, project, "pw")).toEqual([
      {
        label: "Session pooler",
        url: "postgresql://hs_my_app_owner.hattisar:pw@db.example.test:54322/my_app",
        masked: `postgresql://hs_my_app_owner.hattisar:${MASK}@db.example.test:54322/my_app`,
      },
      {
        label: "Transaction pooler",
        url: "postgresql://hs_my_app_owner.hattisar:pw@db.example.test:6543/my_app",
        masked: `postgresql://hs_my_app_owner.hattisar:${MASK}@db.example.test:6543/my_app`,
      },
    ]);
  });

  it("offers one direct string for a box without a pooler", () => {
    expect(ownerConnectionStrings(direct, project, "pw")).toEqual([
      {
        label: "Direct",
        url: "postgresql://hs_my_app_owner:pw@pg.example.test:5433/my_app",
        masked: `postgresql://hs_my_app_owner:${MASK}@pg.example.test:5433/my_app`,
      },
    ]);
  });

  it("URL-encodes the password", () => {
    const [string] = ownerConnectionStrings(direct, project, "a/b+c=d");
    expect(string?.url).toBe(
      "postgresql://hs_my_app_owner:a%2Fb%2Bc%3Dd@pg.example.test:5433/my_app",
    );
  });
});
