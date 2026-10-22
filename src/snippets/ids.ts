// A port of Studio's generateDeterministicUuid. The browser computes snippet ids itself before
// saving, so any drift here makes saved snippets unreachable by the ids Studio asks for.
export function deterministicUuid(parts: (string | null)[]): string {
  let seed = hash(parts.filter(Boolean).join("_"));
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    // Plain double arithmetic, not Math.imul: Studio's product exceeds 2^53 and loses precision
    // before the mask, and the ids depend on that rounding.
    seed = (0x41c64e6d * seed + 12345) & 0x7fffffff;
    const byte = (seed >>> 16) & 255;
    bytes[i] = i === 6 ? (byte & 0x0f) | 0x40 : i === 8 ? (byte & 0x3f) | 0x80 : byte;
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hash(text: string): number {
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    value = (value << 5) - value + text.charCodeAt(i);
    value &= value;
  }
  return Math.abs(value);
}

export function snippetId(folderId: string | null, name: string): string {
  return deterministicUuid([folderId, `${name}.sql`]);
}

export function folderId(name: string): string {
  return deterministicUuid([name]);
}
