import type { PoolerTenants, ResyncResult } from "../../src/pooler/tenants.js";
import { type Box, getBoxById } from "../../src/registry/boxes.js";
import type { Registry } from "../../src/registry/db.js";

export interface PoolerCall {
  action: "ensure" | "drop" | "resync";
  box: Box;
  rowExists: boolean;
}

export class RecordingPooler implements PoolerTenants {
  calls: PoolerCall[] = [];
  reconciled = 0;
  resyncResult: ResyncResult = { ok: true, tenant: "hattisar-resynced" };

  constructor(private readonly db: Registry) {}

  async ensure(box: Box): Promise<void> {
    this.record("ensure", box);
  }

  async drop(box: Box): Promise<void> {
    this.record("drop", box);
  }

  async resync(box: Box): Promise<ResyncResult> {
    this.record("resync", box);
    return this.resyncResult;
  }

  async reconcile(): Promise<void> {
    this.reconciled++;
  }

  private record(action: PoolerCall["action"], box: Box): void {
    this.calls.push({ action, box, rowExists: getBoxById(this.db, box.id) !== undefined });
  }
}
