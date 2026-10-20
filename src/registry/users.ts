import type { Registry } from "./db.js";

export interface User {
  id: number;
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, username, password_hash AS passwordHash, created_at AS createdAt,
  updated_at AS updatedAt`;

export function insertUser(
  db: Registry,
  user: { username: string; passwordHash: string },
  now: string = new Date().toISOString(),
): User {
  return db
    .prepare<[string, string, string, string], User>(
      `INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)
       RETURNING ${COLUMNS}`,
    )
    .get(user.username, user.passwordHash, now, now) as User;
}

export function getUserById(db: Registry, id: number): User | undefined {
  return db.prepare<[number], User>(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id);
}

export function getUserByUsername(db: Registry, username: string): User | undefined {
  return db
    .prepare<[string], User>(`SELECT ${COLUMNS} FROM users WHERE username = ?`)
    .get(username);
}

export function countUsers(db: Registry): number {
  return db.prepare<[], number>("SELECT count(*) FROM users").pluck().get() as number;
}

export function updateUserPasswordHash(
  db: Registry,
  id: number,
  passwordHash: string,
  now: string = new Date().toISOString(),
): void {
  db.prepare<[string, string, number]>(
    "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
  ).run(passwordHash, now, id);
}
