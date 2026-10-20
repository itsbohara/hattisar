import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretError extends Error {
  override name = "SecretError";
}

export function deriveSecretKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    ...[iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")),
  ].join(":");
}

// The thrown error never carries the cause: it must stay safe to log whatever went wrong.
export function decryptSecret(stored: string, key: Buffer): string {
  const [version, iv, tag, ciphertext, ...rest] = stored.split(":");
  if (version !== VERSION || ciphertext === undefined || rest.length > 0) {
    throw new SecretError("stored secret is not in v1 format");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, decodeExact(iv, IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAuthTag(decodeExact(tag, TAG_BYTES));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretError("stored secret could not be decrypted");
  }
}

function decodeExact(part: string | undefined, bytes: number): Buffer {
  const decoded = Buffer.from(part ?? "", "base64");
  if (decoded.length !== bytes) throw new SecretError("bad length");
  return decoded;
}
