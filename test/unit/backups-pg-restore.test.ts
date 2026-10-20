import { describe, expect, it } from "vitest";
import { restoreList } from "../../src/backups/pg-restore.js";

// pg_restore --list of a project database: baseline objects plus a user table and function.
const TOC = `;
; Archive created at 2026-10-20 19:50:00 UTC
;
9; 2615 25135 SCHEMA - extensions supabase_admin
3473; 0 0 ACL - SCHEMA extensions supabase_admin
8; 2615 2200 SCHEMA - public exp_owner
4; 3079 25184 EXTENSION - pg_stat_statements 
3474; 0 0 COMMENT - EXTENSION pg_stat_statements 
2; 3079 25136 EXTENSION - pgcrypto 
3475; 0 0 COMMENT - EXTENSION pgcrypto 
3476; 0 0 COMMENT - EXTENSION "uuid-ossp" 
239; 1255 25313 FUNCTION public f() exp_owner
223; 1259 25307 TABLE public widgets exp_owner
224; 1259 25308 TABLE public extensions_log exp_owner
3465; 0 25307 TABLE DATA public widgets exp_owner`;

describe("restoreList", () => {
  it("drops the extensions schema and extension comments, keeping everything else", () => {
    const kept = restoreList(TOC).split("\n");
    expect(kept).not.toContain("9; 2615 25135 SCHEMA - extensions supabase_admin");
    expect(kept.filter((line) => line.includes("COMMENT - EXTENSION"))).toEqual([]);
    expect(kept).toEqual(
      expect.arrayContaining([
        "3473; 0 0 ACL - SCHEMA extensions supabase_admin",
        "8; 2615 2200 SCHEMA - public exp_owner",
        "4; 3079 25184 EXTENSION - pg_stat_statements ",
        "239; 1255 25313 FUNCTION public f() exp_owner",
        "224; 1259 25308 TABLE public extensions_log exp_owner",
        "3465; 0 25307 TABLE DATA public widgets exp_owner",
      ]),
    );
    expect(kept).toHaveLength(TOC.split("\n").length - 4);
  });
});
