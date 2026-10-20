import type { BackupKind } from "../registry/backups.js";

export const DEFAULT_PREFIX = "hattisar";

export function utcStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll(/[-:]/g, "");
}

export function dumpFilename(ref: string, at: Date): string {
  return `${ref}-${utcStamp(at)}.dump`;
}

export function backupKey(prefix: string, ref: string, kind: BackupKind, at: Date): string {
  return `${prefix}/${ref}/${utcStamp(at)}-${kind}.dump`;
}

export function connectionTestKey(prefix: string): string {
  return `${prefix}/.hattisar-test`;
}

export function normalizePrefix(raw: string): string {
  return (
    raw
      .trim()
      .replace(/^\/+|\/+$/g, "")
      .trim() || DEFAULT_PREFIX
  );
}
