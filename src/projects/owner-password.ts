import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";

const SCRAM_ITERATIONS = 4096;
const PLAINTEXT_ONLY = "only supports being given plaintext passwords";

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

// Neon refuses a verifier with this message under the catch-all SQLSTATE XX000, so only the text
// identifies it; there the plaintext is the only way to set a password.
export async function setRolePassword(
  client: pg.Client,
  statement: (passwordLiteral: string) => string,
  password: string,
): Promise<void> {
  try {
    await client.query(statement(pg.escapeLiteral(scramVerifier(password))));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(PLAINTEXT_ONLY)) throw error;
    await client.query(statement(pg.escapeLiteral(password)));
  }
}
