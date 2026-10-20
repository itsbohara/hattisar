import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Backup } from "../registry/backups.js";
import { connectionTestKey } from "./naming.js";
import { redact } from "./redact.js";
import type { S3Settings } from "./s3-settings.js";

const CONNECTION_TIMEOUT_MS = 5_000;
// Socket inactivity, not total duration: a long upload or download keeps going while bytes flow,
// and a store that stops answering fails the request instead of hanging it and the scheduler.
const SOCKET_IDLE_TIMEOUT_MS = 60_000;

export function s3Client(settings: S3Settings): S3Client {
  return new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    forcePathStyle: settings.forcePathStyle,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    // The SDK's default CRC checksums on every request are rejected by several S3-compatible
    // stores; send them only where the S3 API requires one.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SOCKET_IDLE_TIMEOUT_MS,
    },
  });
}

// S3 errors are shown on the page and stored with failed backups; the secret is masked in case a
// store echoes it.
export function s3ErrorMessage(error: unknown, settings: S3Settings): string {
  const message = redact(error, [settings.secretAccessKey]);
  const name = error instanceof Error ? error.name : "";
  return name === "" || name === "Error" || message.startsWith(name)
    ? message
    : `${name}: ${message}`;
}

export async function testS3Connection(
  settings: S3Settings,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  const client = s3Client(settings);
  const target = { Bucket: settings.bucket, Key: connectionTestKey(settings.prefix) };
  try {
    await client.send(new PutObjectCommand({ ...target, Body: "hattisar connection test\n" }));
    await client.send(new DeleteObjectCommand(target));
    return { ok: true };
  } catch (error) {
    return { ok: false, problem: s3ErrorMessage(error, settings) };
  } finally {
    client.destroy();
  }
}

export async function uploadStream(settings: S3Settings, key: string, body: Readable) {
  const client = s3Client(settings);
  try {
    await new Upload({ client, params: { Bucket: settings.bucket, Key: key, Body: body } }).done();
  } finally {
    client.destroy();
  }
}

type StoredBackup = Pick<Backup, "bucket" | "s3Key">;

// A backup lives in the bucket it was written to, whatever the settings say now.
function backupObject(settings: S3Settings, backup: StoredBackup) {
  return { Bucket: backup.bucket ?? settings.bucket, Key: backup.s3Key };
}

export async function deleteBackupObject(
  settings: S3Settings,
  backup: StoredBackup,
): Promise<void> {
  const client = s3Client(settings);
  try {
    await client.send(new DeleteObjectCommand(backupObject(settings, backup)));
  } finally {
    client.destroy();
  }
}

export async function downloadBackupObject(
  settings: S3Settings,
  backup: StoredBackup,
  path: string,
): Promise<void> {
  const client = s3Client(settings);
  try {
    const { Body } = await client.send(new GetObjectCommand(backupObject(settings, backup)));
    if (!(Body instanceof Readable)) throw new Error(`S3 returned no body for ${backup.s3Key}`);
    await pipeline(Body, createWriteStream(path));
  } finally {
    client.destroy();
  }
}
