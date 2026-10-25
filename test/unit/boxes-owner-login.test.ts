import { describe, expect, it } from "vitest";
import { ownerLogin } from "../../src/boxes/owner-login.js";

describe("ownerLogin", () => {
  it("is the owner role on a box reached directly", () => {
    expect(ownerLogin({ host: "db.example.com", adminUser: "rds.admin" }, "hs_x_owner")).toBe(
      "hs_x_owner",
    );
  });

  it("carries the project ref through Supabase's pooler", () => {
    const box = { host: "aws-0-us-east-1.pooler.supabase.com", adminUser: "postgres.abcref" };
    expect(ownerLogin(box, "hs_x_owner")).toBe("hs_x_owner.abcref");
  });

  it("leaves the role alone when the pooler admin has no project ref", () => {
    const box = { host: "aws-0-us-east-1.pooler.supabase.com", adminUser: "postgres" };
    expect(ownerLogin(box, "hs_x_owner")).toBe("hs_x_owner");
  });
});
