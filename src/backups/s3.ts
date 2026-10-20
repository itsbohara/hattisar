import type { Readable } from "node:stream";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { connectionTestKey } from "./naming.js";
import { redact } from "./redact.js";
import type { S3Settings } from "./s3-settings.js";

const CONNECTION_TIMEOUT_MS = 5_000;

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
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS },
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

export async function deleteObject(settings: S3Settings, key: string): Promise<void> {
  const client = s3Client(settings);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: key }));
  } finally {
    client.destroy();
  }
}
