import type { AdminClientRunner } from "../../src/boxes/admin-client.js";

export interface GatedAdmin {
  admin: AdminClientRunner;
  entered: Promise<void>;
  release: () => void;
}

// An admin runner that parks every call until released, so a test can start a second operation
// while the first one is still on the box.
export function gatedAdmin(inner: AdminClientRunner): GatedAdmin {
  let release!: () => void;
  let enter!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const admin: AdminClientRunner = async (conn, run) => {
    enter();
    await open;
    return inner(conn, run);
  };
  return { admin, entered, release };
}

export function countedAdmin(inner: AdminClientRunner): {
  admin: AdminClientRunner;
  calls: () => number;
} {
  let calls = 0;
  const admin: AdminClientRunner = (conn, run) => {
    calls += 1;
    return inner(conn, run);
  };
  return { admin, calls: () => calls };
}
