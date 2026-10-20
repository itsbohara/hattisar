import type { PortRange } from "../config.js";

export function pickPort(range: PortRange, used: Iterable<number>): number | undefined {
  const taken = new Set(used);
  for (let port = range.start; port <= range.end; port++) {
    if (!taken.has(port)) return port;
  }
  return undefined;
}
