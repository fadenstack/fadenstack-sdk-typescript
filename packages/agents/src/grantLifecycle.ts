import type { AgentGrant } from "@fadenstack/client";

import { AgentGrants } from "./grants.js";

/** What the device says about its screen: locked, unlocked, or that it cannot tell. */
export type ScreenLockState = "unknown" | "unlocked" | "locked";

/**
 * Why a grant ended, as `GrantLifecycle` says it: `time` (its time was up), `stopped` (Stop, here or by the person
 * elsewhere), `elsewhere` (it left the server's list and the server cannot say why), `spent` (its calls were used up),
 * `locked` (the screen stayed locked for `LOCKED_FOR`), `away` (paused for `PAUSED_LIMIT` while the app was closed),
 * `admin`, `kill_switch`, `limit` (the server's word), `host` (the app ended it: a setting of its own was turned off).
 */
export type GrantEndReason = "time" | "stopped" | "elsewhere" | "spent" | "locked" | "away" | "admin" | "kill_switch" | "limit" | "host";

/** A grant of this device ended, and why. */
export interface GrantEnded {
  /** The grant as the copy last held it. */
  readonly grant: AgentGrant;
  readonly reason: GrantEndReason;
  /** When it ended by the server's clock: its time for `time`, when it was paused for `away`. */
  readonly endedAt: Date;
  /** How long it ran, in milliseconds, from when it was made to `endedAt`. */
  readonly ran: number;
  /** How many calls ran under it. */
  readonly callsUsed: number;
}

/** A running grant is near its end: the app may offer another `KEEP_GOING_BY`. */
export interface GrantEndingSoon {
  readonly grant: AgentGrant;
  /** The time left by the server's clock, in milliseconds. */
  readonly left: number;
}

/**
 * How one grant fared when the app started again: `resumed`, `ended_away` (paused too long: ended), `refused` (the server
 * ended it as it refused the resume), `unavailable` (the server could not check: it stays paused and is tried at each
 * tick), `offline` (the same, the server was out of reach), `waits_for_unlock` (the screen is locked), `gone` (the server
 * had ended it already).
 */
export type GrantResumeOutcome = "resumed" | "ended_away" | "refused" | "unavailable" | "offline" | "waits_for_unlock" | "gone";

/** What `GrantLifecycle.stop` did: `grants` tried, `ended` ended (one the server had ended already counts). */
export interface GrantStopResult {
  readonly grants: number;
  readonly ended: number;
  /** Every grant ended; otherwise those left run on at the server until their time. */
  readonly complete: boolean;
}

export interface GrantLifecycleOptions {
  /** The grants the lifecycle looks after: by default a stretch of work and Bypass. */
  manages?: (grant: AgentGrant) => boolean;
  /** Of those, the grants the lock pauses and, locked for `LOCKED_FOR`, ends: by default a stretch of work. */
  pausedByLock?: (grant: AgentGrant) => boolean;
  /** How often it looks by itself, in milliseconds (`TICK_EVERY` by default); 0: never, and the host calls `tick`. */
  tickEvery?: number;
}

interface TrackedGrant {
  last: AgentGrant;
  readonly firstSeen: number;
  ending?: GrantEndReason | undefined;
  endedAt?: number | undefined;
  pausedByLock: boolean;
  askedFor?: string | undefined;
}

const MINUTE = 60_000;
const errorStatus = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
};

/**
 * The rules that keep a server-held grant (a stretch of work, Bypass) from running on unattended (sdk/46 G2), for every
 * host to share. The host feeds it what only it knows -- the app ends, the app starts again, the screen locks or
 * unlocks -- and it pauses, resumes and ends the grants of this device for the agent by the server's clock, and says
 * when one is near its end and when one ended and why:
 *
 * - **The app's end** (`appEnding`): every running grant is paused at the server. Its time runs on.
 * - **The next start** (`appStarted`): a grant paused less than `PAUSED_LIMIT` resumes, with no card and no second
 *   sign-in; one paused longer ends (`away`). One running is left running.
 * - **The lock** (`setScreenLock`): a stretch of work pauses while the screen is locked and resumes with the unlock;
 *   locked for `LOCKED_FOR`, it ends (`locked`). `unknown` never pauses, and after a lock it never resumes.
 * - **Stop** (`stop`): every grant of this device it looks after ends, a paused one too.
 * - **Near the end** (`onEndingSoon`): once per end time, `ENDING_SOON_BEFORE` before it (not for Bypass, which is never
 *   extended); `keepGoing` adds `KEEP_GOING_BY`.
 * - **The end** (`onEnded`): once per grant, with the reason this device knows, or the server's word.
 *
 * The server decides every call; this only pauses, resumes and ends. In a browser a host feeds `appEnding` from
 * `pagehide` (with `visibilitychange` to hidden where the page may be frozen), `appStarted` once it is signed in at
 * load, and `setScreenLock` from whatever it knows (the Idle Detection API's `screenState`, or `unknown`, which pauses
 * nothing). A tab that only goes to the background is not "locked". .NET: `Fadenstack.Agents.GrantLifecycle`.
 */
export class GrantLifecycle {
  /** A grant paused by the app's end ends at the next start when it was paused this long (by the server's clock). */
  static readonly PAUSED_LIMIT = AgentGrants.resumeWithin;
  /** A grant paused by the lock ends after this long locked. */
  static readonly LOCKED_FOR = 30 * MINUTE;
  /** How long before the end `onEndingSoon` is raised. */
  static readonly ENDING_SOON_BEFORE = 2 * MINUTE;
  /** What `keepGoing` adds. */
  static readonly KEEP_GOING_BY = 30 * MINUTE;
  /** How often the lifecycle looks while a grant runs, when it ticks by itself. */
  static readonly TICK_EVERY = 15_000;
  /** How often the server's list is read again while a grant runs: one the server ended leaves the copy. */
  static readonly REFRESH_EVERY = 30_000;
  /** How long `appEnding` waits for the pauses by default. */
  static readonly QUIT_WITHIN = 3_000;

  readonly grants: AgentGrants;
  readonly #manages: (grant: AgentGrant) => boolean;
  readonly #pausedByLock: (grant: AgentGrant) => boolean;
  readonly #records = new Map<string, TrackedGrant>();
  readonly #ended = new Set<string>();
  readonly #retry = new Set<string>();
  readonly #stop = new AbortController();
  readonly #endedListeners = new Set<(event: GrantEnded) => void>();
  readonly #soonListeners = new Set<(event: GrantEndingSoon) => void>();
  readonly #changedListeners = new Set<() => void>();
  readonly #unsubscribe: () => void;
  readonly #timer: ReturnType<typeof setInterval> | undefined;
  #screen: ScreenLockState = "unknown";
  #locked = false;
  #lockedAt = 0;
  #refreshedAt: number;
  #resolving = false;
  #disposed = false;

  constructor(grants: AgentGrants, options: GrantLifecycleOptions = {}) {
    this.grants = grants;
    this.#manages = options.manages ?? (g => g.kind === "work" || g.kind === "bypass");
    this.#pausedByLock = options.pausedByLock ?? (g => g.kind === "work");
    this.#refreshedAt = grants.serverNow.getTime();
    this.#unsubscribe = grants.onChanged(() => this.#look());
    this.#look();
    const every = options.tickEvery ?? GrantLifecycle.TICK_EVERY;
    if (every > 0) {
      this.#timer = setInterval(() => void this.tick(this.#stop.signal).catch(() => undefined), every);
      (this.#timer as { unref?: () => void }).unref?.();
    }
  }

  // -- events --------------------------------------------------------------------------------------------------

  /** A grant of this device ended (once per grant), and why. Returns the unsubscribe. */
  onEnded(listener: (event: GrantEnded) => void): () => void {
    this.#endedListeners.add(listener);
    return () => this.#endedListeners.delete(listener);
  }

  /** A running grant that can be extended is `ENDING_SOON_BEFORE` from its end (once per end time). */
  onEndingSoon(listener: (event: GrantEndingSoon) => void): () => void {
    this.#soonListeners.add(listener);
    return () => this.#soonListeners.delete(listener);
  }

  /** The lifecycle looked again (a tick, a pause, a resume, a change of the copy): a marker brings its time left up to date. */
  onChanged(listener: () => void): () => void {
    this.#changedListeners.add(listener);
    return () => this.#changedListeners.delete(listener);
  }

  // -- state ---------------------------------------------------------------------------------------------------

  /** The last screen state the host gave. */
  get screen(): ScreenLockState { return this.#screen; }

  /** Whether the screen is locked (it stays so while the host cannot read it). */
  get isLocked(): boolean { return this.#locked; }

  /** The grants it looks after that are live (active or paused), the one ending first first. */
  get running(): readonly AgentGrant[] { return this.grants.live.filter(this.#manages); }

  /** How many grants wait to resume or end at the next tick: the server could not check, or could not be reached. */
  get waiting(): number { return this.#retry.size; }

  // -- what the host feeds -------------------------------------------------------------------------------------

  /**
   * The app ends: every running grant it looks after is paused at the server, waiting at most `within` milliseconds
   * (`QUIT_WITHIN`). Its time runs on; the next start resumes it. Offline, or past the limit, a grant runs on at the
   * server until its time. Returns how many were paused. Call it from `pagehide`; a browser may not wait for it.
   */
  async appEnding(within: number = GrantLifecycle.QUIT_WITHIN, signal?: AbortSignal): Promise<number> {
    if (this.#disposed) return 0;
    const active = this.running.filter(g => g.status === "active").map(g => g.id);
    if (active.length === 0) return 0;
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), within);
    const forward = () => limit.abort();
    signal?.addEventListener("abort", forward, { once: true });
    let paused = 0;
    try {
      for (const id of active) {
        try {
          await this.grants.pause(id, limit.signal);
          paused++;
        } catch {
          // offline, ended meanwhile, or out of time: it runs on at the server until its time
        }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forward);
    }
    return paused;
  }

  /**
   * The app starts again, once signed in: reads the server's list, then each grant paused for less than `PAUSED_LIMIT`
   * by the server's clock resumes -- no card, no second sign-in -- and each paused longer ends (`away`). The server may
   * refuse a resume (403: no longer allowed; `onEnded` says why) or not be able to check (503) or be out of reach: the
   * grant stays paused and is tried again at each tick. With the screen locked, a paused grant resumes with the unlock.
   */
  async appStarted(signal?: AbortSignal): Promise<{ grant: AgentGrant; outcome: GrantResumeOutcome }[]> {
    try {
      await this.grants.refresh(signal);
    } catch {
      // offline: the copy is what the device knows
    }
    this.#look();
    const results = await this.#resolvePaused(undefined, signal);
    this.#look();
    return results;
  }

  /**
   * The screen locked or unlocked. Locked, each grant that pauses on the lock pauses and ends after `LOCKED_FOR` locked;
   * unlocked, what the lock paused resumes and what it ended and could not tell the server ends now. `unknown` changes
   * nothing: it never pauses, and after a lock it never resumes either. Completes when the server has been told.
   */
  async setScreenLock(state: ScreenLockState, signal?: AbortSignal): Promise<void> {
    if (this.#disposed) return;
    this.#screen = state;
    if (state === "unknown") return;
    const locked = state === "locked";
    if (locked === this.#locked) return;
    this.#locked = locked;
    if (locked) this.#lockedAt = this.grants.serverNow.getTime();
    if (locked) await this.#pauseForLock(signal);
    else await this.#resumeAfterLock(signal);
    this.#look();
  }

  /**
   * Stop: ends every grant of this device that the lifecycle looks after, a paused one too, and says `stopped` without
   * asking the server. One the server ended meanwhile counts as ended. The host stops the running turns of their
   * conversations itself. Never throws for an unreachable server: the result says how many ended, and those left run on
   * at the server until their time.
   */
  async stop(signal?: AbortSignal): Promise<GrantStopResult> {
    const all = this.running;
    const now = this.grants.serverNow.getTime();
    for (const grant of all) {
      const record = this.#track(grant);
      record.ending ??= "stopped";
      record.endedAt ??= now;
    }
    let ended = 0;
    for (const grant of all) {
      if (await this.#tryRevoke(grant.id, signal)) ended++;
      else {
        const record = this.#records.get(grant.id);
        if (record?.ending === "stopped") { record.ending = undefined; record.endedAt = undefined; }
      }
    }
    this.#look();
    return { grants: all.length, ended, complete: ended >= all.length };
  }

  /** Ends one grant for a reason of the app's own (`host`, say a setting turned off). An unreachable server is thrown. */
  async end(grantId: string, reason: GrantEndReason = "host", signal?: AbortSignal): Promise<void> {
    const grant = this.grants.find(grantId);
    if (grant) {
      const record = this.#track(grant);
      record.ending ??= reason;
      record.endedAt ??= this.grants.serverNow.getTime();
    }
    try {
      await this.grants.revoke(grantId, signal);
    } catch (error) {
      if (errorStatus(error) === 404) await this.#refreshQuietly(signal); // ended meanwhile: the copy drops it
      else {
        const record = this.#records.get(grantId);
        if (record?.ending === reason) { record.ending = undefined; record.endedAt = undefined; }
        throw error;
      }
    }
    this.#look();
  }

  /**
   * Keeps `grantId` going for another `KEEP_GOING_BY`, the same bounds (the notice near the end). The server cuts it at
   * the longest grant from its start and past that refuses (`grant_at_longest`, thrown); a Bypass grant is never extended.
   */
  async keepGoing(grantId: string, shownText?: string, signal?: AbortSignal): Promise<AgentGrant> {
    const grant = await this.grants.extend(grantId, GrantLifecycle.KEEP_GOING_BY, [], shownText, signal);
    const record = this.#records.get(grantId);
    if (record) { record.last = grant; record.askedFor = undefined; }
    this.#look();
    return grant;
  }

  /**
   * One look: the server's list once in `REFRESH_EVERY` while a grant runs, a resume the server could not take is tried
   * again, the end after `LOCKED_FOR` locked, the grants that ended, the ones near their end. The lifecycle calls this by
   * itself every `TICK_EVERY` unless the host set it not to.
   */
  async tick(signal?: AbortSignal): Promise<void> {
    if (this.#disposed) return;
    if (this.running.length > 0 && this.grants.serverNow.getTime() - this.#refreshedAt >= GrantLifecycle.REFRESH_EVERY) {
      this.#refreshedAt = this.grants.serverNow.getTime();
      await this.#refreshQuietly(signal);
    }
    if (this.#retry.size > 0) await this.#resolvePaused(new Set(this.#retry), signal);
    if (this.#locked && this.grants.serverNow.getTime() - this.#lockedAt >= GrantLifecycle.LOCKED_FOR) await this.#endAfterLock(signal);
    this.#look();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#stop.abort();
    this.#unsubscribe();
    this.#endedListeners.clear();
    this.#soonListeners.clear();
    this.#changedListeners.clear();
  }

  // -- the copy ------------------------------------------------------------------------------------------------

  #track(grant: AgentGrant): TrackedGrant {
    let record = this.#records.get(grant.id);
    if (!record) {
      record = { last: grant, firstSeen: this.grants.serverNow.getTime(), pausedByLock: false };
      this.#records.set(grant.id, record);
    } else record.last = grant;
    return record;
  }

  // The copy moved, or a tick: new grants are followed, gone ones end, the ones near their end say so.
  #look(): void {
    if (this.#disposed) return;
    const live = this.grants.live.filter(this.#manages);
    for (const grant of live) if (this.#records.has(grant.id) || !this.#ended.has(grant.id)) this.#track(grant);
    const gone: TrackedGrant[] = [];
    for (const record of [...this.#records.values()]) {
      if (live.some(g => g.id === record.last.id)) continue;
      this.#records.delete(record.last.id);
      this.#ended.add(record.last.id);
      this.#retry.delete(record.last.id);
      gone.push(record);
    }
    const soon: GrantEndingSoon[] = [];
    for (const record of this.#records.values()) {
      const left = this.grants.remaining(record.last);
      if (record.last.kind !== "bypass" && record.last.status === "active" && left > 0 && left <= GrantLifecycle.ENDING_SOON_BEFORE) {
        if (record.askedFor !== record.last.expiresAt) {
          record.askedFor = record.last.expiresAt;
          soon.push({ grant: record.last, left });
        }
      } else if (record.askedFor !== undefined && left > GrantLifecycle.ENDING_SOON_BEFORE) record.askedFor = undefined;
    }
    for (const record of gone) this.#conclude(record);
    for (const event of soon) for (const listener of [...this.#soonListeners]) this.#call(() => listener(event));
    for (const listener of [...this.#changedListeners]) this.#call(listener);
  }

  #call(action: () => void): void {
    try { action(); } catch { /* a listener's failure is its own */ }
  }

  #raise(event: GrantEnded): void {
    for (const listener of [...this.#endedListeners]) this.#call(() => listener(event));
  }

  // A grant left the copy: the reason this device knows (its own end, its calls, its time), else the server's word.
  #conclude(record: TrackedGrant): void {
    const last = record.last;
    const now = this.grants.serverNow.getTime();
    const known: GrantEndReason | undefined = record.ending
      ?? (last.maxCalls !== null && last.callsUsed >= last.maxCalls ? "spent" : now >= Date.parse(last.expiresAt) ? "time" : undefined);
    const endedAt = record.endedAt ?? (known === "time" ? Date.parse(last.expiresAt) : now);
    const started = last.issuedAt ? Date.parse(last.issuedAt) : record.firstSeen;
    const ran = endedAt > started ? endedAt - started : 0;
    if (known) this.#raise({ grant: last, reason: known, endedAt: new Date(endedAt), ran, callsUsed: last.callsUsed });
    else void this.#endedByServer(last, endedAt, ran);
  }

  // The server ended it: its word says who; offline or unknown, the grant says the server ended it.
  async #endedByServer(last: AgentGrant, endedAt: number, ran: number): Promise<void> {
    let why: string | null = null;
    try {
      why = await this.grants.whyEnded(last.id, this.#stop.signal);
    } catch {
      if (this.#stop.signal.aborted) return;
    }
    if (this.#disposed) return;
    const reason: GrantEndReason = why === "person" ? "stopped" : why === "admin" ? "admin" : why === "kill_switch" ? "kill_switch"
      : why === "limit" ? "limit" : why === "expired" ? "time" : why === "spent" ? "spent" : "elsewhere";
    this.#raise({ grant: last, reason, endedAt: new Date(endedAt), ran, callsUsed: last.callsUsed });
  }

  async #refreshQuietly(signal?: AbortSignal): Promise<void> {
    try {
      await this.grants.refresh(signal);
    } catch {
      // offline: the copy stays; its times still end it
    }
  }

  // Revokes a grant; true when it is ended (one the server ended already counts), false when the server could not be told.
  async #tryRevoke(grantId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.grants.revoke(grantId, signal);
      return true;
    } catch (error) {
      if (errorStatus(error) !== 404) return false; // offline: it runs on at the server until its time
      // ended meanwhile: the copy drops it now, as end() does, not at the next look (.NET 46062f5)
      await this.#refreshQuietly(signal);
      return true;
    }
  }

  // -- the next start ------------------------------------------------------------------------------------------

  async #resolvePaused(only: ReadonlySet<string> | undefined, signal?: AbortSignal): Promise<{ grant: AgentGrant; outcome: GrantResumeOutcome }[]> {
    const results: { grant: AgentGrant; outcome: GrantResumeOutcome }[] = [];
    if (this.#resolving || this.#disposed) return results;
    this.#resolving = true;
    let refused = false;
    try {
      for (const grant of this.running.filter(g => g.status === "paused" && (!only || only.has(g.id)))) {
        const outcome = await this.#resolve(grant, signal);
        results.push({ grant, outcome });
        refused ||= outcome === "refused";
      }
    } finally {
      this.#resolving = false;
    }
    if (refused) await this.#refreshQuietly(signal); // the grants the server ended leave the copy
    return results;
  }

  async #resolve(grant: AgentGrant, signal?: AbortSignal): Promise<GrantResumeOutcome> {
    const now = () => this.grants.serverNow.getTime();
    const pausedAt = grant.pausedAt ? Date.parse(grant.pausedAt) : now();
    this.#retry.delete(grant.id);
    const record = this.#track(grant);
    const tooLong = now() - pausedAt >= GrantLifecycle.PAUSED_LIMIT;
    let awaitingUnlock = false;
    if (tooLong) { record.ending = "away"; record.endedAt = pausedAt; }
    else { awaitingUnlock = this.#locked; record.pausedByLock ||= awaitingUnlock; }
    if (tooLong) {
      if (await this.#tryRevoke(grant.id, signal)) return "ended_away";
      this.#retry.add(grant.id); // ends at the next tick, or at its time
      return "offline";
    }
    if (awaitingUnlock) return "waits_for_unlock";
    try {
      await this.grants.resume(grant.id, signal);
      return "resumed";
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404) return "gone"; // ended elsewhere meanwhile: the list drops it and onEnded says why
      if (status === 403) return "refused"; // no longer allowed: the server ended it
      this.#retry.add(grant.id);
      return status === 503 ? "unavailable" : "offline";
    }
  }

  // -- the lock ------------------------------------------------------------------------------------------------

  async #pauseForLock(signal?: AbortSignal): Promise<void> {
    for (const grant of this.running.filter(g => g.status === "active" && this.#pausedByLock(g))) {
      try {
        await this.grants.pause(grant.id, signal);
        this.#track(grant).pausedByLock = true;
      } catch {
        // ended meanwhile, or offline: the server's clock ends it anyway
      }
    }
  }

  // Back: what the lock paused resumes; what the lock ended (and could not tell the server then) ends now.
  async #resumeAfterLock(signal?: AbortSignal): Promise<void> {
    const work = [...this.#records.values()].filter(r => r.pausedByLock || r.ending === "locked" || r.ending === "away")
      .map(r => ({ id: r.last.id, end: r.ending === "locked" || r.ending === "away" }));
    for (const { id, end } of work) {
      try {
        if (end) await this.grants.revoke(id, signal);
        else await this.grants.resume(id, signal);
      } catch {
        // ended meanwhile (404): the copy drops it; offline: it stays paused until its time
      }
      const record = this.#records.get(id);
      if (record && !end) record.pausedByLock = false;
    }
  }

  async #endAfterLock(signal?: AbortSignal): Promise<void> {
    const now = this.grants.serverNow.getTime();
    for (const grant of this.running.filter(this.#pausedByLock)) {
      const record = this.#track(grant);
      record.ending ??= "locked";
      record.endedAt ??= now;
      await this.#tryRevoke(grant.id, signal); // offline: ends at the unlock, or at its time
    }
  }
}
