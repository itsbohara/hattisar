import {
  type AdminClientRunner,
  type BoxConnection,
  withAdminClient,
} from "../boxes/admin-client.js";

export const READY_TIMEOUT_MS = 120_000;
const RETRY_MS = 1_000;

// First boot of supabase/postgres runs its migrations behind a socket-only server, so a TCP login
// succeeding means the box is fully initialised.
export async function waitUntilReady(
  conn: BoxConnection,
  timeoutMs: number = READY_TIMEOUT_MS,
  admin: AdminClientRunner = withAdminClient,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await admin(conn, (client) => client.query("select 1"));
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(
          `Postgres in ${conn.host} did not become ready within ${timeoutMs / 1000}s`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
}
