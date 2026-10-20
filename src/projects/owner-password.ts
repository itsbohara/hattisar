import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

const SCRAM_ITERATIONS = 4096;

export function generateOwnerPassword(): string {
  return randomBytes(32).toString("base64url");
}

// CREATE/ALTER ROLE get this verifier instead of the plaintext: with log_min_error_statement a
// failed statement is written to the box's server log verbatim, password included.
// No SASLprep: generated passwords are base64url, which it leaves unchanged.
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const hmac = (key: Buffer, text: string) => createHmac("sha256", key).update(text).digest();
  const storedKey = createHash("sha256").update(hmac(salted, "Client Key")).digest("base64");
  const serverKey = hmac(salted, "Server Key").toString("base64");
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}
