import type { Registry } from "./db.js";

export type BoxKind = "shared" | "registered" | "managed";

export interface NewBox {
  name: string;
  kind: BoxKind;
  devOnly: boolean;
  host: string;
  port: number;
  adminUser: string;
  adminPasswordEnc: string;
  sslmode: string;
  publicHost: string;
  publicPort: number;
  poolerTenant: string | null;
  poolerSessionPort: number | null;
  poolerTransactionPort: number | null;
  containerName: string | null;
  adminSuperuser: boolean;
}

export interface Box extends NewBox {
  id: number;
  createdAt: string;
}

export type BoxUpdate = Partial<Omit<NewBox, "kind">>;

type BoxRow = Omit<Box, "devOnly" | "adminSuperuser"> & { devOnly: number; adminSuperuser: number };

const COLUMN_NAMES = {
  name: "name",
  kind: "kind",
  devOnly: "dev_only",
  host: "host",
  port: "port",
  adminUser: "admin_user",
  adminPasswordEnc: "admin_password_enc",
  sslmode: "sslmode",
  publicHost: "public_host",
  publicPort: "public_port",
  poolerTenant: "pooler_tenant",
  poolerSessionPort: "pooler_session_port",
  poolerTransactionPort: "pooler_transaction_port",
  containerName: "container_name",
  adminSuperuser: "admin_superuser",
} as const satisfies Record<keyof NewBox, string>;

const COLUMNS = [
  "id",
  ...Object.entries(COLUMN_NAMES).map(([field, column]) => `${column} AS ${field}`),
  "created_at AS createdAt",
].join(", ");

const UPDATABLE_FIELDS = (Object.keys(COLUMN_NAMES) as (keyof NewBox)[]).filter(
  (field): field is keyof BoxUpdate => field !== "kind",
);

const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(["devOnly", "adminSuperuser"]);

function toBox({ devOnly, adminSuperuser, ...row }: BoxRow): Box {
  return { ...row, devOnly: devOnly === 1, adminSuperuser: adminSuperuser === 1 };
}

function toParams(fields: Partial<NewBox>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) => [
      field,
      BOOLEAN_FIELDS.has(field) ? Number(value) : value,
    ]),
  );
}

export function insertBox(db: Registry, box: NewBox, now: string = new Date().toISOString()): Box {
  const fields = Object.keys(COLUMN_NAMES) as (keyof NewBox)[];
  const row = db
    .prepare<[Record<string, unknown>], BoxRow>(
      `INSERT INTO boxes (${fields.map((field) => COLUMN_NAMES[field]).join(", ")}, created_at)
       VALUES (${fields.map((field) => `@${field}`).join(", ")}, @createdAt)
       RETURNING ${COLUMNS}`,
    )
    .get({ ...toParams(box), createdAt: now }) as BoxRow;
  return toBox(row);
}

export function getBoxById(db: Registry, id: number): Box | undefined {
  const row = db.prepare<[number], BoxRow>(`SELECT ${COLUMNS} FROM boxes WHERE id = ?`).get(id);
  return row && toBox(row);
}

export function getBoxByName(db: Registry, name: string): Box | undefined {
  const row = db.prepare<[string], BoxRow>(`SELECT ${COLUMNS} FROM boxes WHERE name = ?`).get(name);
  return row && toBox(row);
}

export function getSharedBox(db: Registry): Box | undefined {
  const row = db.prepare<[], BoxRow>(`SELECT ${COLUMNS} FROM boxes WHERE kind = 'shared'`).get();
  return row && toBox(row);
}

export function listBoxes(db: Registry): Box[] {
  return db.prepare<[], BoxRow>(`SELECT ${COLUMNS} FROM boxes ORDER BY name`).all().map(toBox);
}

// Column names come from COLUMN_NAMES, never from the caller's keys.
export function updateBox(db: Registry, id: number, update: BoxUpdate): void {
  const fields = UPDATABLE_FIELDS.filter((field) => update[field] !== undefined);
  if (fields.length === 0) return;
  const assignments = fields.map((field) => `${COLUMN_NAMES[field]} = @${field}`).join(", ");
  const params = toParams(Object.fromEntries(fields.map((field) => [field, update[field]])));
  db.prepare<[Record<string, unknown>]>(`UPDATE boxes SET ${assignments} WHERE id = @id`).run({
    ...params,
    id,
  });
}

// Throws (SQLITE_CONSTRAINT_FOREIGNKEY) while any project, active or deleted, is on the box.
export function deleteBox(db: Registry, id: number): void {
  db.prepare<[number]>("DELETE FROM boxes WHERE id = ?").run(id);
}
