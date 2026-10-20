import { describe, expect, it } from "vitest";
import {
  backupKey,
  connectionTestKey,
  dumpFilename,
  normalizePrefix,
  utcStamp,
} from "../../src/backups/naming.js";

const at = new Date("2026-03-04T05:06:07.890Z");

describe("utcStamp", () => {
  it("formats as UTC yyyymmddThhmmssZ without milliseconds", () => {
    expect(utcStamp(at)).toBe("20260304T050607Z");
  });

  it("uses UTC whatever the local offset", () => {
    expect(utcStamp(new Date("2026-12-31T23:59:59+05:45"))).toBe("20261231T181459Z");
  });
});

describe("dumpFilename", () => {
  it("is <ref>-<stamp>.dump", () => {
    expect(dumpFilename("my-app", at)).toBe("my-app-20260304T050607Z.dump");
  });
});

describe("backupKey", () => {
  it("is <prefix>/<ref>/<stamp>-<kind>.dump", () => {
    expect(backupKey("hattisar", "my-app", "manual", at)).toBe(
      "hattisar/my-app/20260304T050607Z-manual.dump",
    );
    expect(backupKey("team/dbs", "my-app", "scheduled", at)).toBe(
      "team/dbs/my-app/20260304T050607Z-scheduled.dump",
    );
  });
});

describe("connectionTestKey", () => {
  it("is <prefix>/.hattisar-test", () => {
    expect(connectionTestKey("hattisar")).toBe("hattisar/.hattisar-test");
  });
});

describe("normalizePrefix", () => {
  it("defaults a blank prefix to hattisar", () => {
    expect(normalizePrefix("")).toBe("hattisar");
    expect(normalizePrefix(" / ")).toBe("hattisar");
  });

  it("trims whitespace and surrounding slashes", () => {
    expect(normalizePrefix(" /team/dbs/ ")).toBe("team/dbs");
  });
});
