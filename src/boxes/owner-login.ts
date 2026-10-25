import type { Box } from "../registry/boxes.js";

const SUPABASE_POOLER_HOST = /\.pooler\.supabase\.com$/;

// Supabase's pooler finds the project from the login name, "<role>.<project ref>": the admin was
// registered that way, and an owner logging in through the same host needs the same suffix.
export function ownerLogin(box: Pick<Box, "host" | "adminUser">, ownerRole: string): string {
  if (!SUPABASE_POOLER_HOST.test(box.host)) return ownerRole;
  const dot = box.adminUser.lastIndexOf(".");
  return dot === -1 ? ownerRole : `${ownerRole}${box.adminUser.slice(dot)}`;
}
