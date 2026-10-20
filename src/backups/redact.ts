// Backup errors are stored in the registry and shown on the project page, so every secret the
// failing step held is masked, whether or not the tool is known to echo it.
export function redact(error: unknown, secrets: string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  return secrets.reduce(
    (text, secret) => (secret === "" ? text : text.replaceAll(secret, "********")),
    message,
  );
}
