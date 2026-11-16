import { planMyData, type AuditVerification, type DataDeletion, type DataScope, type MyDataApp, type MyDataExport } from "@fadenstack/agents";
import type { MyDataAuditSource, MyDataSource } from "@fadenstack/ui";

// The states of the "Your data" control and a source that keeps what was asked: for the view model's and the skins' tests.

export const APP_A = "Word add-in";
export const APP_B = "Desktop agent";

const app = (name: string, agents: string[], isThisApp: boolean, recorded = true): MyDataApp =>
  ({ name, agents, isThisApp, recorded, ...(recorded ? { lastSeen: "2026-11-16T10:00:00.000Z" } : {}) });

/** Who uses the person's data in each state: this app alone; with another app; with another app that runs the same agent. */
export const SCENARIOS = {
  alone: [app(APP_A, ["docs"], true)],
  others: [app(APP_A, ["docs"], true), app(APP_B, ["desktop-assistant"], false), app("excel-assistant", ["excel-assistant"], false, false)],
  "shared-agent": [app(APP_A, ["docs"], true), app(APP_B, ["desktop-assistant", "docs"], false)],
} as const satisfies Record<string, MyDataApp[]>;

export type ScenarioName = keyof typeof SCENARIOS;

/** A source with a list of apps; it records what was exported and removed, and can be made to fail or to wait. */
export class FakeMyData implements MyDataSource {
  readonly appName = APP_A;
  readonly calls: string[] = [];
  apps_: MyDataApp[];
  failExport = false;
  failRemove = false;
  hostStoresLeft = false;
  /** While set, an export or a removal waits for it. */
  gate: Promise<void> | undefined;
  /** The record of tool calls, once `withAudit()` gave the source one. */
  audit: MyDataAuditSource | undefined;
  /** What the check of the record finds: 12 entries since 1 August 2026, intact, unless a test says otherwise. */
  verification: AuditVerification = { intact: true, entries: 12, firstSeq: 1, firstTime: "2026-08-01T10:00:00.000Z", lastTime: "2026-11-16T09:00:00.000Z" };
  failAudit = false;
  failAuditExport = false;

  /** Gives the source a record of tool calls (the line and the button show). */
  withAudit(): this {
    this.audit = {
      verify: () => {
        this.calls.push("audit");
        return this.failAudit ? Promise.reject(new Error("boom: secret detail of the check")) : Promise.resolve({ ...this.verification });
      },
      export: () => {
        this.calls.push("audit-export");
        return this.failAuditExport ? Promise.reject(new Error("boom: secret detail of the export")) : Promise.resolve("<!DOCTYPE html><title>Record</title>");
      },
    };
    return this;
  }

  constructor(scenario: ScenarioName) {
    this.apps_ = SCENARIOS[scenario].map((a) => ({ ...a, agents: [...a.agents] }));
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  apps(): Promise<MyDataApp[]> {
    return Promise.resolve(this.apps_.map((a) => ({ ...a })));
  }

  async export(scope: DataScope): Promise<MyDataExport> {
    this.calls.push(`export:${scope}`);
    await this.gate;
    if (this.failExport) throw new Error("boom: secret detail of the export");
    return { format: "fadenstack-my-data", version: 1, exportedAt: "2026-11-16T10:00:00.000Z", sessions: [], approvals: [],
      counts: { agents: 0, sessions: 0, approvals: 0, unreadable: 0 }, notIncluded: [], scope };
  }

  async remove(scope: DataScope): Promise<DataDeletion> {
    this.calls.push(`remove:${scope}`);
    await this.gate;
    if (this.failRemove) throw new Error("boom: secret detail of the removal");
    const plan = planMyData(this.apps_);
    const result: DataDeletion = {
      storesCleared: 1, hostSessionStoreLeft: this.hostStoresLeft, hostApprovalStoreLeft: false, hostStoresLeft: this.hostStoresLeft, scope,
      otherApps: scope === "thisApp" ? plan.otherApps.map((a) => a.name) : [], sharedDataKept: scope === "thisApp" && !plan.sharedGoes,
      agentsKept: scope === "thisApp" ? plan.keptAgents : [],
    };
    this.apps_ = scope === "allApps" ? [] : this.apps_.filter((a) => !a.isThisApp);
    return result;
  }
}
