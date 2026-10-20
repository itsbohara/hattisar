import type { Registry } from "../registry/db.js";
import { decryptSecret, encryptSecret } from "../registry/secrets.js";
import { deleteSetting, getSetting, setSetting } from "../registry/settings.js";
import { DEFAULT_PREFIX, normalizePrefix } from "./naming.js";

export interface S3Settings {
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  prefix: string;
}

export interface S3FormValues {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  forcePathStyle: boolean;
  prefix: string;
}

export interface S3Form extends S3FormValues {
  secretAccessKey: string;
}

const KEY = {
  endpoint: "s3.endpoint",
  region: "s3.region",
  bucket: "s3.bucket",
  accessKeyId: "s3.access_key_id",
  secretAccessKeyEnc: "s3.secret_access_key_enc",
  forcePathStyle: "s3.force_path_style",
  prefix: "s3.prefix",
} as const;

const PREFIX_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function storedS3Form(db: Registry): { values: S3FormValues; secretSet: boolean } {
  return {
    values: {
      endpoint: getSetting(db, KEY.endpoint) ?? "",
      region: getSetting(db, KEY.region) ?? "",
      bucket: getSetting(db, KEY.bucket) ?? "",
      accessKeyId: getSetting(db, KEY.accessKeyId) ?? "",
      forcePathStyle: getSetting(db, KEY.forcePathStyle) === "true",
      prefix: getSetting(db, KEY.prefix) ?? DEFAULT_PREFIX,
    },
    secretSet: getSetting(db, KEY.secretAccessKeyEnc) !== undefined,
  };
}

// Saving validates every field, so a stored bucket means the whole configuration is present.
export function isS3Configured(db: Registry): boolean {
  return getSetting(db, KEY.bucket) !== undefined;
}

export function loadS3Settings(db: Registry, secretKey: Buffer): S3Settings | undefined {
  const secretEnc = getSetting(db, KEY.secretAccessKeyEnc);
  if (!isS3Configured(db) || secretEnc === undefined) return undefined;
  const { values } = storedS3Form(db);
  return {
    ...values,
    endpoint: values.endpoint || undefined,
    secretAccessKey: decryptSecret(secretEnc, secretKey),
  };
}

function isHttpUrl(value: string): boolean {
  return URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);
}

// A blank secret keeps the stored one.
export function validateS3Form(
  db: Registry,
  secretKey: Buffer,
  form: S3Form,
): S3Settings | string[] {
  const problems: string[] = [];
  if (form.endpoint !== "" && !isHttpUrl(form.endpoint)) {
    problems.push("Endpoint must be an http(s) URL, or blank for AWS S3");
  }
  if (form.region === "") problems.push("Region is required");
  if (!BUCKET_PATTERN.test(form.bucket)) {
    problems.push("Bucket must be 3-63 characters: lowercase letters, digits, dots and hyphens");
  }
  if (form.accessKeyId === "") problems.push("Access key ID is required");
  const storedSecret = getSetting(db, KEY.secretAccessKeyEnc);
  if (form.secretAccessKey === "" && storedSecret === undefined) {
    problems.push("Secret access key is required");
  }
  const prefix = normalizePrefix(form.prefix);
  if (!PREFIX_PATTERN.test(prefix)) {
    problems.push(
      "Key prefix may contain letters, digits, dots, hyphens and underscores, separated by /",
    );
  }
  if (problems.length > 0) return problems;
  return {
    endpoint: form.endpoint || undefined,
    region: form.region,
    bucket: form.bucket,
    accessKeyId: form.accessKeyId,
    secretAccessKey:
      form.secretAccessKey === ""
        ? decryptSecret(storedSecret as string, secretKey)
        : form.secretAccessKey,
    forcePathStyle: form.forcePathStyle,
    prefix,
  };
}

export function saveS3Settings(db: Registry, secretKey: Buffer, settings: S3Settings): void {
  db.transaction(() => {
    if (settings.endpoint === undefined) deleteSetting(db, KEY.endpoint);
    else setSetting(db, KEY.endpoint, settings.endpoint);
    setSetting(db, KEY.region, settings.region);
    setSetting(db, KEY.bucket, settings.bucket);
    setSetting(db, KEY.accessKeyId, settings.accessKeyId);
    setSetting(db, KEY.secretAccessKeyEnc, encryptSecret(settings.secretAccessKey, secretKey));
    setSetting(db, KEY.forcePathStyle, String(settings.forcePathStyle));
    setSetting(db, KEY.prefix, settings.prefix);
  })();
}
