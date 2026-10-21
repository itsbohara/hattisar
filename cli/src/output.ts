export interface Writer {
  write(text: string): unknown;
}

export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  "),
    )
    .join("\n");
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

export function utc(iso: string | null): string {
  return iso === null ? "-" : `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function printJson(out: Writer, value: unknown): void {
  out.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLines(out: Writer, text: string): void {
  out.write(`${text}\n`);
}
