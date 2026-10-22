import { describe, expect, it } from "vitest";
import { deterministicUuid, folderId, snippetId } from "../../src/snippets/ids.js";

// Recorded from generateDeterministicUuid (module 703627) in supabase/studio:2026.10.12-sha-3699278.
const REPORTS_FOLDER = "2b034b04-cb70-4b95-b057-31902663e494";
const STUDIO_VECTORS: [(string | null)[], string][] = [
  [[null, "a.sql"], "6a8cb761-7d95-4af2-84d9-b765fd4bc274"],
  [[null, "Untitled query.sql"], "4ff53731-32b2-4671-ab7b-a0481b0f09dd"],
  [[REPORTS_FOLDER, "daily.sql"], "c2cf74f3-0378-4228-bb1b-b25ae24c5576"],
  [["reports"], REPORTS_FOLDER],
  [["Ünïcödé 名前"], "7278d397-ffee-4247-849e-47cc7b7c96d8"],
  [[null, ""], "00dc04f5-79f8-481a-8b87-eca53b9e9a39"],
];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("snippet ids", () => {
  it.each(STUDIO_VECTORS)("deterministicUuid(%j) matches Studio", (parts, expected) => {
    expect(deterministicUuid(parts)).toBe(expected);
    expect(deterministicUuid(parts)).toMatch(UUID_V4);
  });

  it("derives a snippet id from its folder and name", () => {
    expect(snippetId(null, "a")).toBe("6a8cb761-7d95-4af2-84d9-b765fd4bc274");
    expect(snippetId(null, "Untitled query")).toBe("4ff53731-32b2-4671-ab7b-a0481b0f09dd");
    expect(snippetId(REPORTS_FOLDER, "daily")).toBe("c2cf74f3-0378-4228-bb1b-b25ae24c5576");
  });

  it("derives a folder id from its name", () => {
    expect(folderId("reports")).toBe(REPORTS_FOLDER);
    expect(folderId("Ünïcödé 名前")).toBe("7278d397-ffee-4247-849e-47cc7b7c96d8");
  });
});
