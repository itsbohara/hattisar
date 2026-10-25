import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteBackup,
  failRunningBackups,
  getBackup,
  getBackupSchedule,
  insertBackup,
  listBackups,
  listEnabledBackupSchedules,
  markBackupDone,
  markBackupFailed,
  setBackupSchedule,
} from "../../src/registry/backups.js";
import {
  deleteBox,
  getBoxById,
  getBoxByName,
  getSharedBox,
  insertBox,
  listBoxes,
  type NewBox,
  updateBox,
} from "../../src/registry/boxes.js";
import { openRegistry, type Registry } from "../../src/registry/db.js";
import {
  deleteProject,
  getProjectById,
  getProjectByRef,
  insertProject,
  listProjects,
  listProjectsDeletedBefore,
  listProjectsOnBox,
  markProjectDeleted,
  markProjectRestored,
  type NewProject,
  renameProject,
  setProjectLogin,
  setProjectOwnerPassword,
} from "../../src/registry/projects.js";
import {
  deleteExpiredSessions,
  deleteOtherSessions,
  deleteSession,
  getSession,
  insertSession,
} from "../../src/registry/sessions.js";
import { deleteSetting, getSetting, setSetting } from "../../src/registry/settings.js";
import {
  countUsers,
  getUserById,
  getUserByUsername,
  insertUser,
  updateUserPasswordHash,
} from "../../src/registry/users.js";

const T0 = "2026-10-20T00:00:00.000Z";
const T1 = "2026-10-21T00:00:00.000Z";
const T2 = "2026-10-22T00:00:00.000Z";

let dataDir: string;
let db: Registry;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "hattisar-repos-"));
  db = openRegistry(dataDir);
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function box(overrides: Partial<NewBox> = {}): NewBox {
  return {
    name: "shared",
    kind: "shared",
    devOnly: true,
    host: "db",
    port: 5432,
    adminUser: "supabase_admin",
    adminPasswordEnc: "v1:iv:tag:ct",
    sslmode: "disable",
    publicHost: "localhost",
    publicPort: 5432,
    poolerTenant: "tenant",
    poolerSessionPort: 54322,
    poolerTransactionPort: 6543,
    containerName: null,
    adminSuperuser: true,
    ...overrides,
  };
}

function registeredBox(name = "prod-1"): NewBox {
  return box({
    name,
    kind: "registered",
    devOnly: false,
    poolerTenant: null,
    poolerSessionPort: null,
    poolerTransactionPort: null,
  });
}

function project(boxId: number, ref = "alpha-app"): NewProject {
  const dbName = ref.replaceAll("-", "_");
  return {
    ref,
    name: `Project ${ref}`,
    boxId,
    dbName,
    ownerRole: `hs_${dbName}_owner`,
    ownerPasswordEnc: "v1:iv:tag:pw",
  };
}

function constraintError(code: string) {
  return expect.objectContaining({ code });
}

describe("users", () => {
  it("inserts and reads by id and username", () => {
    const user = insertUser(db, { username: "admin", passwordHash: "scrypt$hash" }, T0);
    expect(user).toEqual({
      id: expect.any(Number),
      username: "admin",
      passwordHash: "scrypt$hash",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(getUserById(db, user.id)).toEqual(user);
    expect(getUserByUsername(db, "admin")).toEqual(user);
    expect(getUserByUsername(db, "nobody")).toBeUndefined();
    expect(countUsers(db)).toBe(1);
  });

  it("rejects a duplicate username", () => {
    insertUser(db, { username: "admin", passwordHash: "a" });
    expect(() => insertUser(db, { username: "admin", passwordHash: "b" })).toThrow(
      constraintError("SQLITE_CONSTRAINT_UNIQUE"),
    );
  });

  it("updates the password hash and updated_at", () => {
    const user = insertUser(db, { username: "admin", passwordHash: "old" }, T0);
    updateUserPasswordHash(db, user.id, "new", T1);
    expect(getUserById(db, user.id)).toMatchObject({
      passwordHash: "new",
      createdAt: T0,
      updatedAt: T1,
    });
  });
});

describe("sessions", () => {
  it("inserts, reads and deletes", () => {
    const user = insertUser(db, { username: "admin", passwordHash: "h" });
    const session = insertSession(db, { tokenHash: "t1", userId: user.id, expiresAt: T1 }, T0);
    expect(session).toEqual({ tokenHash: "t1", userId: user.id, createdAt: T0, expiresAt: T1 });
    expect(getSession(db, "t1")).toEqual(session);
    deleteSession(db, "t1");
    expect(getSession(db, "t1")).toBeUndefined();
  });

  it("deletes the user's other sessions only", () => {
    const admin = insertUser(db, { username: "admin", passwordHash: "h" });
    const other = insertUser(db, { username: "other", passwordHash: "h" });
    for (const tokenHash of ["keep", "drop"]) {
      insertSession(db, { tokenHash, userId: admin.id, expiresAt: T2 });
    }
    insertSession(db, { tokenHash: "elsewhere", userId: other.id, expiresAt: T2 });
    deleteOtherSessions(db, admin.id, "keep");
    expect(getSession(db, "keep")).toBeDefined();
    expect(getSession(db, "drop")).toBeUndefined();
    expect(getSession(db, "elsewhere")).toBeDefined();
  });

  it("deletes expired sessions", () => {
    const user = insertUser(db, { username: "admin", passwordHash: "h" });
    insertSession(db, { tokenHash: "old", userId: user.id, expiresAt: T1 });
    insertSession(db, { tokenHash: "fresh", userId: user.id, expiresAt: T2 });
    deleteExpiredSessions(db, T1);
    expect(getSession(db, "old")).toBeUndefined();
    expect(getSession(db, "fresh")).toBeDefined();
  });

  it("rejects a session for an unknown user", () => {
    expect(() => insertSession(db, { tokenHash: "t", userId: 999, expiresAt: T1 })).toThrow(
      constraintError("SQLITE_CONSTRAINT_FOREIGNKEY"),
    );
  });
});

describe("boxes", () => {
  it("inserts and maps every column, including booleans and nulls", () => {
    const shared = insertBox(db, box(), T0);
    expect(shared).toEqual({ ...box(), id: expect.any(Number), createdAt: T0 });
    const registered = insertBox(db, registeredBox());
    expect(registered.devOnly).toBe(false);
    expect(registered.poolerTenant).toBeNull();
    expect(getBoxById(db, shared.id)).toEqual(shared);
    expect(getBoxByName(db, "prod-1")).toEqual(registered);
    expect(getSharedBox(db)).toEqual(shared);
    expect(listBoxes(db).map((b) => b.name)).toEqual(["prod-1", "shared"]);
  });

  it("round-trips adminSuperuser and updates it", () => {
    const box = insertBox(db, { ...registeredBox(), adminSuperuser: false });
    expect(box.adminSuperuser).toBe(false);
    expect(getBoxById(db, box.id)?.adminSuperuser).toBe(false);
    updateBox(db, box.id, { adminSuperuser: true });
    expect(getBoxById(db, box.id)?.adminSuperuser).toBe(true);
  });

  it("reads a row written without admin_superuser as a superuser box", () => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO boxes (name, kind, dev_only, host, port, admin_user, admin_password_enc,
           sslmode, public_host, public_port, created_at)
         VALUES ('old', 'registered', 0, 'h', 5432, 'u', 'p', 'disable', 'h', 5432, 't')`,
      )
      .run();
    expect(getBoxById(db, Number(lastInsertRowid))?.adminSuperuser).toBe(true);
  });

  it("updates only the given fields", () => {
    const before = insertBox(db, registeredBox());
    updateBox(db, before.id, { devOnly: true, host: "10.0.0.5", containerName: null });
    const after = { ...before, devOnly: true, host: "10.0.0.5" };
    expect(getBoxById(db, before.id)).toEqual(after);
    updateBox(db, before.id, {});
    expect(getBoxById(db, before.id)).toEqual(after);
  });

  it("rejects a duplicate name and a second shared box", () => {
    insertBox(db, box());
    expect(() => insertBox(db, registeredBox("shared"))).toThrow(
      constraintError("SQLITE_CONSTRAINT_UNIQUE"),
    );
    expect(() => insertBox(db, box({ name: "shared-2" }))).toThrow(
      constraintError("SQLITE_CONSTRAINT_UNIQUE"),
    );
  });

  it("rejects an unknown kind and a non-boolean dev_only", () => {
    expect(() => insertBox(db, box({ kind: "cloud" as NewBox["kind"] }))).toThrow(
      constraintError("SQLITE_CONSTRAINT_CHECK"),
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO boxes (name, kind, dev_only, host, port, admin_user, admin_password_enc,
             sslmode, public_host, public_port, created_at)
           VALUES ('x', 'registered', 2, 'h', 5432, 'u', 'p', 'disable', 'h', 5432, 't')`,
        )
        .run(),
    ).toThrow(constraintError("SQLITE_CONSTRAINT_CHECK"));
  });

  it("refuses to delete a box with projects in any status", () => {
    const { id } = insertBox(db, registeredBox());
    const alpha = insertProject(db, project(id));
    markProjectDeleted(db, alpha.id, "alpha_app__deleted_20261020");
    expect(() => deleteBox(db, id)).toThrow(constraintError("SQLITE_CONSTRAINT_FOREIGNKEY"));
    deleteProject(db, alpha.id);
    deleteBox(db, id);
    expect(getBoxById(db, id)).toBeUndefined();
  });
});

describe("projects", () => {
  let boxId: number;

  beforeEach(() => {
    boxId = insertBox(db, box()).id;
  });

  it("inserts as active and reads by id and ref", () => {
    const alpha = insertProject(db, project(boxId), T0);
    expect(alpha).toEqual({
      ...project(boxId),
      id: expect.any(Number),
      kind: "created",
      loginSuperuser: false,
      status: "active",
      deletedAt: null,
      deletedDbName: null,
      createdAt: T0,
    });
    expect(getProjectById(db, alpha.id)).toEqual(alpha);
    expect(getProjectByRef(db, "alpha-app")).toEqual(alpha);
    expect(listProjectsOnBox(db, boxId)).toEqual([alpha]);
  });

  it("keeps a ref unique across active and deleted rows", () => {
    const alpha = insertProject(db, project(boxId));
    expect(() => insertProject(db, project(boxId))).toThrow(
      constraintError("SQLITE_CONSTRAINT_UNIQUE"),
    );
    markProjectDeleted(db, alpha.id, "alpha_app__deleted_20261020");
    expect(() => insertProject(db, project(boxId))).toThrow(
      constraintError("SQLITE_CONSTRAINT_UNIQUE"),
    );
    expect(getProjectByRef(db, "alpha-app")?.status).toBe("deleted");
  });

  it("soft deletes, lists by status and restores", () => {
    const alpha = insertProject(db, project(boxId, "alpha-app"));
    const beta = insertProject(db, project(boxId, "beta-app"));
    markProjectDeleted(db, beta.id, "beta_app__deleted_20261021", T1);
    expect(getProjectById(db, beta.id)).toMatchObject({
      status: "deleted",
      deletedAt: T1,
      deletedDbName: "beta_app__deleted_20261021",
    });
    expect(listProjects(db, "active").map((p) => p.ref)).toEqual(["alpha-app"]);
    expect(listProjects(db, "deleted").map((p) => p.ref)).toEqual(["beta-app"]);
    expect(listProjectsDeletedBefore(db, T1)).toEqual([]);
    expect(listProjectsDeletedBefore(db, T2).map((p) => p.ref)).toEqual(["beta-app"]);

    markProjectRestored(db, beta.id);
    expect(getProjectById(db, beta.id)).toMatchObject({
      status: "active",
      deletedAt: null,
      deletedDbName: null,
    });
    expect(listProjects(db, "active").map((p) => p.id)).toEqual([alpha.id, beta.id]);
  });

  it("renames and rotates the owner password", () => {
    const alpha = insertProject(db, project(boxId));
    renameProject(db, alpha.id, "Alpha");
    setProjectOwnerPassword(db, alpha.id, "v1:iv:tag:new");
    expect(getProjectById(db, alpha.id)).toMatchObject({
      name: "Alpha",
      ownerPasswordEnc: "v1:iv:tag:new",
    });
  });

  it("defaults to a created project without login superuser", () => {
    const alpha = insertProject(db, project(boxId));
    expect(alpha).toMatchObject({ kind: "created", loginSuperuser: false });
  });

  it("round-trips an attached project with login superuser", () => {
    const alpha = insertProject(db, { ...project(boxId), kind: "attached", loginSuperuser: true });
    expect(getProjectByRef(db, "alpha-app")).toMatchObject({
      kind: "attached",
      loginSuperuser: true,
    });
    expect(alpha).toMatchObject({ kind: "attached", loginSuperuser: true });
  });

  it("replaces the login role, password and superuser flag only", () => {
    const alpha = insertProject(db, project(boxId));
    setProjectLogin(db, alpha.id, "hs_alpha_app_login", "v1:iv:tag:login", true);
    expect(getProjectById(db, alpha.id)).toEqual({
      ...alpha,
      ownerRole: "hs_alpha_app_login",
      ownerPasswordEnc: "v1:iv:tag:login",
      loginSuperuser: true,
    });
  });

  it("rejects an unknown status and an unknown box", () => {
    const alpha = insertProject(db, project(boxId));
    expect(() =>
      db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(alpha.id),
    ).toThrow(constraintError("SQLITE_CONSTRAINT_CHECK"));
    expect(() => insertProject(db, project(999, "orphan-app"))).toThrow(
      constraintError("SQLITE_CONSTRAINT_FOREIGNKEY"),
    );
  });

  it("purging removes the project's backups and schedule", () => {
    const alpha = insertProject(db, project(boxId));
    setBackupSchedule(db, { projectId: alpha.id, frequency: "daily", keepDaily: 7, keepWeekly: 4 });
    const backup = insertBackup(db, {
      projectId: alpha.id,
      kind: "manual",
      bucket: "b",
      s3Key: "k",
    });
    deleteProject(db, alpha.id);
    expect(getProjectById(db, alpha.id)).toBeUndefined();
    expect(getBackup(db, backup.id)).toBeUndefined();
    expect(listEnabledBackupSchedules(db)).toEqual([]);
  });
});

describe("settings", () => {
  it("sets, overwrites, reads and deletes", () => {
    expect(getSetting(db, "s3.bucket")).toBeUndefined();
    setSetting(db, "s3.bucket", "one");
    setSetting(db, "s3.bucket", "two");
    expect(getSetting(db, "s3.bucket")).toBe("two");
    deleteSetting(db, "s3.bucket");
    expect(getSetting(db, "s3.bucket")).toBeUndefined();
  });
});

describe("backups", () => {
  let projectId: number;

  beforeEach(() => {
    const boxId = insertBox(db, box()).id;
    projectId = insertProject(db, project(boxId)).id;
  });

  it("defaults a schedule to off with 7 daily and 4 weekly", () => {
    expect(getBackupSchedule(db, projectId)).toEqual({
      projectId,
      frequency: "off",
      keepDaily: 7,
      keepWeekly: 4,
    });
    expect(listEnabledBackupSchedules(db)).toEqual([]);
  });

  it("upserts a schedule", () => {
    setBackupSchedule(db, { projectId, frequency: "daily", keepDaily: 7, keepWeekly: 4 });
    setBackupSchedule(db, { projectId, frequency: "weekly", keepDaily: 3, keepWeekly: 2 });
    const schedule = { projectId, frequency: "weekly", keepDaily: 3, keepWeekly: 2 };
    expect(getBackupSchedule(db, projectId)).toEqual(schedule);
    expect(listEnabledBackupSchedules(db)).toEqual([schedule]);
  });

  it("records running, done and failed backups, newest first", () => {
    const first = insertBackup(
      db,
      { projectId, kind: "scheduled", bucket: "b", s3Key: "a.dump" },
      T0,
    );
    expect(first).toEqual({
      id: expect.any(Number),
      projectId,
      kind: "scheduled",
      bucket: "b",
      s3Key: "a.dump",
      sizeBytes: null,
      status: "running",
      error: null,
      createdAt: T0,
      finishedAt: null,
    });
    const second = insertBackup(
      db,
      { projectId, kind: "manual", bucket: "b", s3Key: "b.dump" },
      T1,
    );
    markBackupDone(db, first.id, 1234, T1);
    markBackupFailed(db, second.id, "pg_dump exited with code 1", T2);
    expect(listBackups(db, projectId)).toEqual([
      { ...second, status: "failed", error: "pg_dump exited with code 1", finishedAt: T2 },
      { ...first, status: "done", sizeBytes: 1234, finishedAt: T1 },
    ]);
    deleteBackup(db, first.id);
    expect(listBackups(db, projectId).map((b) => b.id)).toEqual([second.id]);
  });

  it("fails every running backup with the given error", () => {
    const running = insertBackup(
      db,
      { projectId, kind: "manual", bucket: "b", s3Key: "a.dump" },
      T0,
    );
    const done = insertBackup(db, { projectId, kind: "manual", bucket: "b", s3Key: "b.dump" }, T0);
    markBackupDone(db, done.id, 10, T1);
    expect(failRunningBackups(db, "interrupted by restart", T2)).toBe(1);
    expect(getBackup(db, running.id)).toMatchObject({
      status: "failed",
      error: "interrupted by restart",
      finishedAt: T2,
    });
    expect(getBackup(db, done.id)).toMatchObject({ status: "done", error: null, finishedAt: T1 });
  });

  it("rejects unknown frequency, kind and status", () => {
    expect(() =>
      setBackupSchedule(db, {
        projectId,
        frequency: "hourly" as "off",
        keepDaily: 7,
        keepWeekly: 4,
      }),
    ).toThrow(constraintError("SQLITE_CONSTRAINT_CHECK"));
    expect(() =>
      insertBackup(db, { projectId, kind: "adhoc" as "manual", bucket: "b", s3Key: "k" }),
    ).toThrow(constraintError("SQLITE_CONSTRAINT_CHECK"));
    const backup = insertBackup(db, { projectId, kind: "manual", bucket: "b", s3Key: "k" });
    expect(() =>
      db.prepare("UPDATE backups SET status = 'queued' WHERE id = ?").run(backup.id),
    ).toThrow(constraintError("SQLITE_CONSTRAINT_CHECK"));
  });
});
