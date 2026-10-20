import CryptoJS from "crypto-js";

// Must stay byte-compatible with Studio's lib/api/self-hosted/util.ts: postgres-meta decrypts
// x-connection-encrypted with the same passphrase-mode AES.
export function encryptConnectionString(connectionString: string, key: string): string {
  return CryptoJS.AES.encrypt(connectionString, key).toString();
}
