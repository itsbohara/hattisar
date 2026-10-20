import { readFileSync } from "node:fs";
import pg from "pg";

// sql/ sits at the app root next to src/ and dist/; the Dockerfile copies it into every stage.
const BASELINE = readFileSync(new URL("../../sql/baseline.sql", import.meta.url), "utf8");

export function baselineSql(dbName: string, ownerRole: string): string {
  return BASELINE.replaceAll(':"owner"', pg.escapeIdentifier(ownerRole)).replaceAll(
    ':"db"',
    pg.escapeIdentifier(dbName),
  );
}
