import {
  type Box,
  deleteBox,
  getBoxById,
  getBoxByName,
  insertBox,
  updateBox,
} from "../registry/boxes.js";
import type { Registry } from "../registry/db.js";
import { listProjectsOnBox } from "../registry/projects.js";
import { decryptSecret, encryptSecret } from "../registry/secrets.js";
import { type BoxConnection, isSslMode, SSL_MODES, type SslMode } from "./admin-client.js";
import type { E1Result } from "./e1.js";

const NAME_PATTERN = /^[a-z][a-z0-9-]{2,39}$/;

export interface BoxFormValues {
  name: string;
  host: string;
  port: string;
  adminUser: string;
  sslmode: string;
  publicHost: string;
  publicPort: string;
  devOnly: boolean;
}

export interface BoxForm extends BoxFormValues {
  adminPassword: string;
}

interface ValidBox {
  name: string;
  host: string;
  port: number;
  adminUser: string;
  sslmode: SslMode;
  publicHost: string;
  publicPort: number;
  devOnly: boolean;
}

export interface BoxServiceDeps {
  db: Registry;
  secretKey: Buffer;
  check: (conn: BoxConnection) => Promise<E1Result>;
}

export type BoxResult = { ok: true; box: Box } | { ok: false; problems: string[] };

// Stored boxes were validated on the way in, so their sslmode is one of SSL_MODES.
export function boxConnection(box: Box, secretKey: Buffer): BoxConnection {
  return {
    host: box.host,
    port: box.port,
    user: box.adminUser,
    password: decryptSecret(box.adminPasswordEnc, secretKey),
    sslmode: box.sslmode as SslMode,
  };
}

export function formValues(box: Box): BoxFormValues {
  return {
    name: box.name,
    host: box.host,
    port: String(box.port),
    adminUser: box.adminUser,
    sslmode: box.sslmode,
    publicHost: box.publicHost,
    publicPort: String(box.publicPort),
    devOnly: box.devOnly,
  };
}

function parsePort(value: string): number | undefined {
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function validate(form: BoxForm, passwordRequired: boolean): ValidBox | string[] {
  const problems: string[] = [];
  if (!NAME_PATTERN.test(form.name)) {
    problems.push(
      "Name must be 3-40 characters: lowercase letters, digits and hyphens, starting with a letter",
    );
  }
  if (form.host === "") problems.push("Host is required");
  const port = parsePort(form.port);
  if (port === undefined) problems.push("Port must be a number between 1 and 65535");
  if (form.adminUser === "") problems.push("Admin user is required");
  if (passwordRequired && form.adminPassword === "") problems.push("Admin password is required");
  if (!isSslMode(form.sslmode)) problems.push(`SSL mode must be one of ${SSL_MODES.join(", ")}`);
  if (form.publicHost === "") problems.push("Public host is required");
  const publicPort = parsePort(form.publicPort);
  if (publicPort === undefined) problems.push("Public port must be a number between 1 and 65535");
  if (problems.length > 0 || port === undefined || publicPort === undefined) return problems;
  return {
    name: form.name,
    host: form.host,
    port,
    adminUser: form.adminUser,
    sslmode: form.sslmode as SslMode,
    publicHost: form.publicHost,
    publicPort,
    devOnly: form.devOnly,
  };
}

async function validateAndCheck(
  { db, check }: BoxServiceDeps,
  form: BoxForm,
  password: string,
  existingId?: number,
): Promise<ValidBox | string[]> {
  const valid = validate(form, existingId === undefined);
  if (Array.isArray(valid)) return valid;
  const sameName = getBoxByName(db, valid.name);
  if (sameName && sameName.id !== existingId) {
    return [`A box named ${valid.name} already exists`];
  }
  const result = await check({
    host: valid.host,
    port: valid.port,
    user: valid.adminUser,
    password,
    sslmode: valid.sslmode,
  });
  return result.ok ? valid : result.problems;
}

export async function registerBox(deps: BoxServiceDeps, form: BoxForm): Promise<BoxResult> {
  const valid = await validateAndCheck(deps, form, form.adminPassword);
  if (Array.isArray(valid)) return { ok: false, problems: valid };
  const box = insertBox(deps.db, {
    ...valid,
    kind: "registered",
    adminPasswordEnc: encryptSecret(form.adminPassword, deps.secretKey),
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
    containerName: null,
  });
  return { ok: true, box };
}

export function editableBox(db: Registry, id: number): Box | undefined {
  const box = getBoxById(db, id);
  return box?.kind === "registered" ? box : undefined;
}

// A blank password keeps the stored one; E1 runs again either way since host or user may change.
export async function editBox(deps: BoxServiceDeps, box: Box, form: BoxForm): Promise<BoxResult> {
  const password =
    form.adminPassword === ""
      ? decryptSecret(box.adminPasswordEnc, deps.secretKey)
      : form.adminPassword;
  const valid = await validateAndCheck(deps, form, password, box.id);
  if (Array.isArray(valid)) return { ok: false, problems: valid };
  updateBox(deps.db, box.id, {
    ...valid,
    adminPasswordEnc:
      form.adminPassword === ""
        ? box.adminPasswordEnc
        : encryptSecret(form.adminPassword, deps.secretKey),
  });
  return { ok: true, box: getBoxById(deps.db, box.id) as Box };
}

export function removeBox(db: Registry, box: Box): { ok: true } | { ok: false; problem: string } {
  const projects = listProjectsOnBox(db, box.id).length;
  if (projects > 0) {
    const noun = projects === 1 ? "project" : "projects";
    return {
      ok: false,
      problem: `Box ${box.name} still has ${projects} ${noun} (including any in Trash). Delete and purge them before removing the box.`,
    };
  }
  deleteBox(db, box.id);
  return { ok: true };
}
