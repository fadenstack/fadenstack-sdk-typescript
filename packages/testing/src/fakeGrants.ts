/**
 * The gateway's grants (`/v1/agents/{agent}/grants`) and the backend's second sign-in (`/api/agent-tokens/step-ups`), as far
 * as the SDK sees them: made, listed, ended, paused, resumed, extended within the longest grant from their start, reported.
 * Ids are `g-1`, `g-2`...; times are `serverNow`'s, which tests set apart from the device's clock. Port of the .NET SDK's
 * `FakeGrants` (tests/Fadenstack.Agents.Tests), on the same wire.
 */

export interface FakeGrantsOptions {
  /**
   * The agent's `approvals` in the profile, as the wire has it. `bypass` in it is what the server would offer to a client
   * that announced the flow; it is left out of the profile for a client that did not.
   */
  approvals?: Record<string, unknown>;
}

/** A request the fake got, for assertions. */
export interface FakeGrantRequest {
  json: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface FakeGrantReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

type Wire = Record<string, unknown>;

export const DEFAULT_APPROVALS: Record<string, unknown> = { standing: null, longest_grant_minutes: 120, grant_classes: ["read", "write"] };

const reply = (status: number, body: unknown, headers?: Record<string, string>): FakeGrantReply => ({ status, body, ...(headers ? { headers } : {}) });
const error = (status: number, code: string, message: string, type = "invalid_request_error"): FakeGrantReply =>
  reply(status, { error: { message, type, param: null, code } });

export class FakeGrants {
  /** The `approvals` the profile shows. */
  approvals: Record<string, unknown>;
  /** The server's clock, in ms: a minute ahead of the device's unless a test says otherwise. */
  serverNow = Date.now() + 60_000;
  /** The server's refusal of the next grants, as its error code (e.g. `grant_not_offered`); undefined: it grants. */
  refuse: string | undefined;
  /** The status of that refusal. */
  refuseStatus = 403;
  longestMinutes = 120;
  /** What new grants record of their calls; undefined: `decisions` for a time grant, else `calls`. */
  evidenceLevel: string | undefined;
  /** How the person answers in the browser: `approved`, `denied` or `expired` (nobody in time). */
  stepUpOutcome: "approved" | "denied" | "expired" = "approved";
  /** How many polls answer `authorization_pending` before the outcome. */
  pendingPolls = 0;
  /** When set, the first poll after the pending ones answers `slow_down` with this interval. */
  slowDown: number | undefined;
  /** The address the second sign-in's pages are given at; undefined: the server's own origin. */
  stepUpOrigin: string | undefined;
  /** The resume of a paused Bypass, as the gateway may refuse it: 403 (ends), 404 (the kill switch), 503. */
  refuseResume: number | undefined;
  /** False: `GET .../grants/{id}` answers 404, as an older server that cannot say why a grant ended. */
  canSayWhy = true;
  /** Changes the grant the server is about to store, as a faulty or hostile server might. */
  tamper: ((grant: Wire) => void) | undefined;
  /** Changes every grant the server shows (made, read or listed). */
  tamperShown: ((grant: Wire) => void) | undefined;
  /** The step-ups the device started, and what each asked the page to show as the longest time. */
  readonly stepUps: { longest: number | null }[] = [];
  /** The polls the device sent. */
  polls = 0;
  /** The requests that made grants. */
  readonly made: FakeGrantRequest[] = [];
  readonly extensions: FakeGrantRequest[] = [];
  /** The reports of turns in Bypass (L-61): the grant, and the calls the device said it ran. */
  readonly reports: { grant: string; calls: string[] }[] = [];
  /** The requests that polled, as sent. */
  readonly pollRequests: Wire[] = [];
  readonly #grants: Wire[] = [];
  readonly #proofs = new Set<string>();
  #pending = 0;
  #device = "device-1";

  /** @param agentId The agent the grants belong to; `agentVersion` its version. */
  constructor(readonly agentId: string, readonly agentVersion: number, options: FakeGrantsOptions = {}) {
    this.approvals = structuredClone(options.approvals ?? DEFAULT_APPROVALS);
  }

  /** The device the grants are shown for (the signed-in device that last asked the profile or the grants). */
  noteDevice(deviceId: string): void {
    this.#device = deviceId;
  }

  get stepUpsStarted(): number {
    return this.stepUps.length;
  }

  /** The server takes no proof it gave out before (they are older than 5 minutes by its clock). */
  proofsGoStale(): void {
    this.#proofs.clear();
  }

  status(id: string): string {
    return String(this.#find(id)["status"]);
  }

  /** A grant held on the server without the device having made it (another app on the device, the console). */
  hold(kind: string, scope: Wire, minutes = 30, status = "active"): string {
    const grant = this.#new(kind, scope, minutes);
    grant["status"] = status;
    grant["calls_used"] = 1; // the gateway counted the call it says the grant covers
    return grant["id"] as string;
  }

  /** The server ends a grant on its own: `admin`, `kill_switch`, `limit`, `person`. The device learns it from the next list. */
  end(id: string, by: string): void {
    const grant = this.#find(id);
    grant["status"] = "revoked";
    grant["revoked_by"] = by;
    grant["revoked_at"] = new Date(this.serverNow).toISOString();
  }

  /** The value of a stream's `faden.grants`: the live grants, as the gateway sends them. */
  snapshot(): { serverNow: string; grants: Wire[] } {
    return { serverNow: new Date(this.serverNow).toISOString(), grants: this.#live().map((g) => this.#shown(g)) };
  }

  /** The profile's `approvals`: the Bypass block only for a client that announced the whole flow. */
  profileApprovals(supports: string | null): Record<string, unknown> {
    const names = (supports ?? "").split(",").map((s) => s.trim());
    const announced = names.includes("tool_mode.bypass") && names.includes("bypass.step_up");
    const { bypass, ...rest } = this.approvals;
    return announced && bypass !== undefined ? { ...rest, bypass } : rest;
  }

  #live(): Wire[] {
    return this.#grants.filter((g) => g["status"] === "active" || g["status"] === "paused");
  }

  #find(id: string): Wire {
    const grant = this.#grants.find((g) => g["id"] === id);
    if (!grant) throw new Error(`No grant ${id}.`);
    return grant;
  }

  #new(kind: string, scope: Wire, minutes: number): Wire {
    const issued = new Date(this.serverNow);
    const grant: Wire = {
      object: "agent.grant", id: `g-${this.#grants.length + 1}`, kind, status: "active", scope,
      issued_at: issued.toISOString(), expires_at: new Date(this.serverNow + minutes * 60_000).toISOString(),
      max_calls: null, calls_used: 0, agent_id: this.agentId, agent_version: this.agentVersion, device_id: null,
      narrowed: [], evidence_level: this.evidenceLevel ?? (kind === "time" ? "decisions" : "calls"),
      conversation_id: null, paused_at: null, revoked_at: null, revoked_by: null,
      step_up: kind === "bypass" ? { method: "password", provider: null, at: issued.toISOString() } : null,
    };
    this.#grants.push(grant);
    return grant;
  }

  #shown(grant: Wire): Wire {
    const shown: Wire = {
      ...grant, device_id: grant["device_id"] ?? this.#device, server_now: new Date(this.serverNow).toISOString(),
      remaining_s: Math.max(0, Math.floor((Date.parse(String(grant["expires_at"])) - this.serverNow) / 1000)),
    };
    this.tamperShown?.(shown);
    return shown;
  }

  #change(id: string, change: (grant: Wire) => void): FakeGrantReply {
    const grant = this.#grants.find((g) => g["id"] === id);
    if (!grant) return error(404, "grant_not_found", "You have no such grant.");
    change(grant);
    return reply(200, this.#shown(grant));
  }

  // -- the second sign-in for Bypass (sdk/41) -------------------------------------------------------

  startStepUp(body: Wire, origin: string): FakeGrantReply {
    this.#pending = 0;
    this.stepUps.push({ longest: typeof body["longest_minutes"] === "number" ? body["longest_minutes"] : null });
    const at = this.stepUpOrigin ?? origin;
    return reply(201, {
      step_up_code: `device-code-${this.stepUps.length}`, user_code: "BCDF-GHJK", verification_uri: `${at}/step-up`,
      verification_uri_complete: `${at}/step-up#code=BCDF-GHJK`, expires_in: 600, interval: 1,
    });
  }

  pollStepUp(body: Wire): FakeGrantReply {
    this.polls += 1;
    this.pollRequests.push(body);
    if (this.#pending++ < this.pendingPolls) return reply(400, { error: "authorization_pending", error_description: "Waiting." });
    if (this.slowDown !== undefined) {
      const interval = this.slowDown;
      this.slowDown = undefined;
      this.#pending -= 1;
      return reply(400, { error: "slow_down", error_description: "Slower.", interval });
    }
    if (this.stepUpOutcome !== "approved") {
      return reply(400, { error: this.stepUpOutcome === "denied" ? "access_denied" : "expired_token", error_description: "No." });
    }
    const proof = `proof-${this.#proofs.size + 1}-${String(body["step_up_code"])}`;
    this.#proofs.add(proof);
    return reply(200, { proof, expires_in: 290, signed_in_at: new Date(this.serverNow).toISOString(), method: "password" });
  }

  /** A Bypass grant needs a proof this server gave out (RFC 9470's challenge otherwise), as the gateway checks. */
  #challenge(headers: Headers): FakeGrantReply | undefined {
    const proof = headers.get("x-faden-step-up");
    if (proof && this.#proofs.has(proof)) return undefined;
    return reply(401, {
      error: { message: "Switching Bypass on needs a fresh sign-in.", type: "authentication_error", code: "bypass_step_up_required" },
      step_up: { max_age: 300, reason: "missing", start: "/api/agent-tokens/step-ups" },
    }, { "www-authenticate": 'Bearer error="insufficient_user_authentication", max_age="300"' });
  }

  // -- the grants -------------------------------------------------------------------------------------

  /** `rest` is what follows `grants`: "", "/g-1", "/g-1/pause"... */
  handle(method: string, rest: string, body: Wire, headers: Headers, deviceId: string): FakeGrantReply {
    this.#device = deviceId;
    const match = /^(?:\/([^/]+)(?:\/(pause|resume|extend|report))?)?$/.exec(rest);
    if (!match) return reply(404, { detail: "Not Found" });
    const [, id, action] = match;
    if (id === undefined) {
      if (method === "GET") return reply(200, { object: "list", data: this.#live().map((g) => this.#shown(g)), server_now: new Date(this.serverNow).toISOString() });
      if (method === "POST") return this.#create(body, headers);
      return reply(405, { detail: "Method Not Allowed" });
    }
    if (action === undefined) {
      if (method === "GET") return this.canSayWhy ? this.#change(id, () => undefined) : reply(404, { detail: "Not Found" });
      if (method === "DELETE") {
        return this.#change(id, (g) => {
          g["status"] = "revoked";
          g["revoked_at"] = new Date(this.serverNow).toISOString();
          g["revoked_by"] = g["revoked_by"] ?? "person";
        });
      }
    }
    if (method !== "POST") return reply(405, { detail: "Method Not Allowed" });
    if (action === "pause") return this.#change(id, (g) => { g["status"] = "paused"; g["paused_at"] = new Date(this.serverNow).toISOString(); });
    if (action === "resume") return this.#resume(id);
    if (action === "extend") return this.#extend(id, body, headers);
    if (action === "report") {
      const calls = Array.isArray(body["calls"]) ? body["calls"].map(String) : [];
      this.reports.push({ grant: id, calls });
      return reply(200, { object: "agent.grant_report", matched: calls.length, device_only: 0, gateway_only: 0 });
    }
    return reply(404, { detail: "Not Found" });
  }

  #resume(id: string): FakeGrantReply {
    const found = this.#grants.find((g) => g["id"] === id);
    if (this.refuseResume !== undefined && found?.["kind"] === "bypass") {
      if (this.refuseResume === 403 || this.refuseResume === 404) {
        found["status"] = "revoked";
        found["revoked_by"] = this.refuseResume === 403 ? "limit" : "kill_switch";
      }
      const code = this.refuseResume === 403 ? "bypass_not_allowed" : this.refuseResume === 404 ? "grant_not_found" : "grant_limits_unavailable";
      return error(this.refuseResume, code, "Not now.");
    }
    return this.#change(id, (g) => { g["status"] = "active"; g["paused_at"] = null; });
  }

  /** More time within the longest grant from its start; a Bypass grant is refused, as the gateway does. */
  #extend(id: string, body: Wire, _headers: Headers): FakeGrantReply {
    const found = this.#grants.find((g) => g["id"] === id);
    if (found?.["kind"] === "bypass") return error(409, "bypass_not_extendable", "A Bypass grant is not extended.");
    this.extensions.push({ json: body, headers: {} });
    return this.#change(id, (grant) => {
      const minutes = typeof body["minutes"] === "number" ? body["minutes"] : 0;
      const issued = Date.parse(String(grant["issued_at"]));
      const wanted = Date.parse(String(grant["expires_at"])) + minutes * 60_000;
      const cap = issued + this.longestMinutes * 60_000;
      grant["expires_at"] = new Date(Math.min(wanted, cap)).toISOString();
      grant["narrowed"] = wanted > cap ? ["minutes"] : [];
      const targets = body["targets"];
      if (Array.isArray(targets) && targets.length && grant["kind"] === "work") {
        const scope = grant["scope"] as Wire;
        scope["targets"] = [...(scope["targets"] as Wire[]), ...(targets as Wire[])];
      }
    });
  }

  #create(body: Wire, headers: Headers): FakeGrantReply {
    if (this.refuse !== undefined) return error(this.refuseStatus, this.refuse, "Not offered.", "permission_error");
    const kind = String(body["kind"]);
    if (kind === "bypass") {
      const challenge = this.#challenge(headers);
      if (challenge) return challenge;
    }
    this.made.push({ json: body, headers: Object.fromEntries(headers.entries()) });
    const minutes = Number(body["minutes"]);
    const scope: Wire = kind === "time" ? { tools: body["tools"] }
      : kind === "bypass" ? { classes: ["read", "write", "destructive", "unknown"] }
      : { classes: body["classes"], targets: body["targets"] };
    const grant = this.#new(kind, scope, Math.min(minutes, this.longestMinutes));
    grant["conversation_id"] = kind === "work" || kind === "bypass" || body["conversation"] === true
      ? headers.get("x-faden-conversation-id") : null;
    grant["narrowed"] = minutes > this.longestMinutes ? ["minutes"] : [];
    this.tamper?.(grant);
    return reply(201, this.#shown(grant));
  }
}
