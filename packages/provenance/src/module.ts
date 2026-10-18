import {
  DEFAULT_PROVENANCE_POLICY,
  FadenstackApiError,
  type ChatStreamer,
  type PlacementReport,
  type ProvenancePolicy,
  type ReceiptNote,
} from "@fadenstack/client";
import {
  StageOrder,
  outputEditKind,
  toolServiceKey,
  type FadenstackModule,
  type ToolCallContext,
  type ToolOutput,
  type ToolServiceCall,
  type ToolStage,
} from "@fadenstack/agents";

import { ServerBackend } from "./backend.js";
import { isCode, isLabel, lengthClass, tokensOf } from "./content.js";
import { HtmlAttributeMarker } from "./markers/htmlAttribute.js";
import { HttpHeaderMarker } from "./markers/httpHeader.js";
import { ImageProvenanceGuard } from "./markers/imageGuard.js";
import { KeyValueMarker } from "./markers/keyValue.js";
import { MarkdownFrontMatterMarker } from "./markers/markdownFrontMatter.js";
import { ServerSignedMarker } from "./markers/serverSigned.js";
import { SidecarMarker } from "./markers/sidecar.js";
import { VisibleLabelMarker } from "./markers/visibleLabel.js";
import { WatermarkStatus } from "./markers/watermarkStatus.js";
import { ProvenanceEntryTypes, ProvenanceUnmarkedError, placeContent, type Insert, type PipelineSettings } from "./pipeline.js";
import { tightenPolicy } from "./policy.js";
import type { MarkStringsOption } from "./titles.js";
import type {
  ContentMarker,
  EditClassifier,
  Placement,
  PlacementObserver,
  PlaceRequest,
  ProvenanceBackend,
  RecordEnricher,
} from "./types.js";

/** The module's name, as an agent profile's `required_client_modules` names it. */
export const PROVENANCE_MODULE = "provenance";

/** What a tool gets from the provenance module for its call: `context.services.get(Provenance)`, or `provenanceOf`. */
export interface Provenance {
  /**
   * Places content through the marking pipeline: `insert` is the host's own insert, given the content as the markers
   * prepared it. Returns where it went and which layers held; throws `ProvenanceRefusedError` when the policy refuses.
   */
  place<T>(request: PlaceRequest, insert: Insert<T>): Promise<Placement<Awaited<T>>>;
  /** The marking policy in force: the server's, tightened by the module's options. */
  policy(): Promise<Required<ProvenancePolicy>>;
  /** The receipt of the answer that made this call, if the server sent one. */
  readonly receipt: ReceiptNote | undefined;
}

/** The key of the provenance module's tool service. */
export const Provenance = toolServiceKey<Provenance>(PROVENANCE_MODULE);

/** The call's `Provenance`; throws when the module is not added to the builder. */
export function provenanceOf(context: ToolCallContext): Provenance {
  const provenance = context.services.get(Provenance);
  if (!provenance) throw new Error("The provenance module is not added: builder.use(provenanceModule()).");
  return provenance;
}

export interface ProvenanceOptions {
  /**
   * Markers for your hosts, after the built-in ones; one with a built-in's name replaces it. A label marker given here
   * (`VisibleLabelMarker`) is always used; without one, the built-in label is used while the policy asks for a label.
   */
  markers?: readonly ContentMarker[];
  /** Decides the edit kind for your domain (`similarityClassifier()`). */
  classifier?: EditClassifier;
  /** Add your own non-personal facts to the records. */
  enrichers?: readonly RecordEnricher[];
  /** See every placement. */
  observers?: readonly PlacementObserver[];
  /** The server calls; the agent's server by default. */
  backend?: ProvenanceBackend;
  /** Local policy: it can only tighten the server's (refuse, a lower threshold, fewer exempt kinds, a label). */
  policy?: ProvenancePolicy;
  /**
   * Development: a tool that declares content (`output`) and does not place it through `place()` fails, instead of
   * only being recorded. Off by default. (A marker that throws is recorded, `failed: <error>`, in either mode.)
   */
  development?: boolean;
  /** Counts a text's tokens for the short-text threshold; four characters a token without one. */
  tokenizer?: (text: string) => number;
  /** The texts the built-in markers write (the HTML title, the visible label), in the user's language. */
  strings?: MarkStringsOption;
}

/**
 * The markers every placement may use, as both SDKs order them: the server's record (`server-record`), the picture
 * guard (`image-guard`), the watermark status (`watermark-status`), HTML (`html-attribute`), Markdown front matter
 * (`front-matter`), key-value, sidecar, HTTP header. Each applies only where the sink carries what it needs; a
 * placement runs them by layer (metadata, watermark, fingerprint, label), in this order within a layer. The visible
 * label is not among them: it applies while the policy asks for one.
 */
export function builtInMarkers(options: { strings?: MarkStringsOption } = {}): ContentMarker[] {
  return [
    new ServerSignedMarker(),
    new ImageProvenanceGuard(),
    new WatermarkStatus(),
    new HtmlAttributeMarker(options.strings ? { strings: options.strings } : {}),
    new MarkdownFrontMatterMarker(),
    new KeyValueMarker(),
    new SidecarMarker(),
    new HttpHeaderMarker(),
  ];
}

/**
 * The provenance module (`provenance`): marks content an agent's tools place, as made with AI. It keeps each turn's
 * receipts (a chat stage), gives tools `place()` (the `Provenance` tool service), and checks after each tool that
 * declares content (`output`) that it went through `place()` (a tool stage at `StageOrder.provenance`).
 */
export function provenanceModule(options: ProvenanceOptions = {}): FadenstackModule {
  return {
    name: PROVENANCE_MODULE,
    configure(builder) {
      const state = new ModuleState(options);
      builder
        .addChatStage(StageOrder.provenance, (inner) => receiptStage(inner, state.receipts))
        .addToolStage(StageOrder.provenance, checkingStage())
        .addToolService(Provenance, (call) => new CallProvenance(state, call));
    },
  };
}

const POLICY_TTL_MS = 5 * 60_000;
const POLICY_RETRY_MS = 30_000;
const POLICY_TIMEOUT_MS = 10_000;
const REPORT_TIMEOUT_MS = 10_000;
const KEPT_TURNS = 32;

/** One agent's module: its pipeline, policy and receipts. */
class ModuleState {
  readonly receipts = new TurnReceipts();
  readonly settings: PipelineSettings;
  readonly options: ProvenanceOptions;
  lastReportError: unknown;
  #backend: ProvenanceBackend | undefined;
  #policy: { value: Required<ProvenancePolicy>; until: number } | undefined;
  #loading: Promise<Required<ProvenancePolicy>> | undefined;

  constructor(options: ProvenanceOptions) {
    this.options = options;
    const own = options.markers ?? [];
    const builtIns = builtInMarkers(options.strings ? { strings: options.strings } : {})
      .map((m) => own.find((o) => o.name === m.name) ?? m);
    const added = own.filter((m) => !builtIns.includes(m));
    this.settings = {
      markers: [...builtIns, ...added],
      policyLabels: [new VisibleLabelMarker(options.strings ? { strings: options.strings } : {})],
      classifier: options.classifier,
      enrichers: options.enrichers ?? [],
      observers: options.observers ?? [],
      tokenizer: options.tokenizer,
      development: options.development ?? false,
    };
  }

  backend(call: ToolServiceCall): ProvenanceBackend {
    return (this.#backend ??= this.options.backend ?? new ServerBackend(call.agent.client));
  }

  policy(call: ToolServiceCall): Promise<Required<ProvenancePolicy>> {
    if (this.#policy && Date.now() < this.#policy.until) return Promise.resolve(this.#policy.value);
    this.#loading ??= this.#load(call).finally(() => {
      this.#loading = undefined;
    });
    return this.#loading;
  }

  async #load(call: ToolServiceCall): Promise<Required<ProvenancePolicy>> {
    try {
      const server = await this.backend(call).policy(AbortSignal.timeout(POLICY_TIMEOUT_MS));
      const value = tightenPolicy(server, this.options.policy, warnOnce);
      this.#policy = { value, until: Date.now() + POLICY_TTL_MS };
      return value;
    } catch (error) {
      // A server without the module has no policy: the contract's defaults. Otherwise the last one known, tried again soon.
      const without = error instanceof FadenstackApiError && error.status === 404;
      const defaults = { ...DEFAULT_PROVENANCE_POLICY, exempt_edit_kinds: [...DEFAULT_PROVENANCE_POLICY.exempt_edit_kinds] };
      const value = this.#policy?.value ?? tightenPolicy(defaults, this.options.policy, warnOnce);
      this.#policy = { value, until: Date.now() + (without ? POLICY_TTL_MS : POLICY_RETRY_MS) };
      return value;
    }
  }
}

/**
 * The receipts of recent turns, per tool call by the answer that made the call: a call from an answer without a
 * receipt (tool calls only) gets none, never an earlier answer's.
 */
class TurnReceipts {
  readonly #turns = new Map<string, Map<string, ReceiptNote | undefined>>();

  keep(turnId: string, notes: readonly ReceiptNote[], callIds: readonly string[]): void {
    let turn = this.#turns.get(turnId);
    if (!turn) {
      turn = new Map();
      this.#turns.set(turnId, turn);
      while (this.#turns.size > KEPT_TURNS) this.#turns.delete(this.#turns.keys().next().value!);
    }
    const answer = [...notes].reverse().find((n) => n.status === "signed") ?? notes[notes.length - 1];
    for (const id of callIds) turn.set(id, answer);
  }

  forCall(turnId: string, callId: string): ReceiptNote | undefined {
    return this.#turns.get(turnId)?.get(callId);
  }
}

/** Keeps the receipts a model call's answer ends with, with the tool calls the answer made. */
function receiptStage(inner: ChatStreamer, receipts: TurnReceipts): ChatStreamer {
  return {
    async *stream(messages, options) {
      const notes: ReceiptNote[] = [];
      const calls: string[] = [];
      try {
        for await (const update of inner.stream(messages, options)) {
          if (update.type === "receipt") notes.push(update.receipt);
          else if (update.type === "tool_calls") calls.push(...update.calls.map((c) => c.id));
          yield update;
        }
      } finally {
        if (options?.turnId && calls.length) receipts.keep(options.turnId, notes, calls);
      }
    },
  };
}

/** After a tool that declares content for people ran: did the content go through `place()`? */
function checkingStage(): ToolStage {
  return {
    async invoke(invocation, next) {
      const result = await next(invocation);
      const output = invocation.tool.output;
      if (!output) return result;
      const value = invocation.arguments[output.argument];
      const empty = value === undefined || value === null || (typeof value === "string" && value.trim() === "")
        || (Array.isArray(value) && value.length === 0);
      if (empty) return result;
      const provenance = invocation.context.services.get(Provenance);
      if (provenance instanceof CallProvenance && provenance.placements === 0) await provenance.unmarked(output, invocation.arguments);
      return result;
    },
  };
}

/** One call's `Provenance`. */
class CallProvenance implements Provenance {
  placements = 0;
  readonly #state: ModuleState;
  readonly #call: ToolServiceCall;

  constructor(state: ModuleState, call: ToolServiceCall) {
    this.#state = state;
    this.#call = call;
  }

  get receipt(): ReceiptNote | undefined {
    return this.#state.receipts.forCall(this.#call.turnId, this.#call.callId);
  }

  policy(): Promise<Required<ProvenancePolicy>> {
    return this.#state.policy(this.#call);
  }

  async place<T>(request: PlaceRequest, insert: Insert<T>): Promise<Placement<Awaited<T>>> {
    this.placements += 1;
    const call = this.#call;
    const output = call.tool.output;
    const receipt = this.receipt;
    const model = call.agent.profile.model;
    return placeContent<Awaited<T>>(this.#state.settings, request, insert as Insert<Awaited<T>>, {
      tool: call.tool.name,
      callId: call.callId,
      ...(output ? { argument: output.argument, declaredEditKind: outputEditKind(output, call.arguments) } : {}),
      ...(receipt ? { receipt } : {}),
      ...(model ? { model } : {}),
      signal: call.signal,
      policy: () => this.policy(),
      backend: this.#state.backend(call),
      record: (type, data) => call.record(type, data),
      notice: (notice) => call.notice(notice),
      reportFailed: (error) => {
        this.#state.lastReportError = error;
      },
    });
  }

  /**
   * Records declared content that did not go through `place()` and reports it without a record (`sink_kind`
   * `unmarked`, no layers); in development, fails. Content exempt from marking (the policy's internal switch, an exempt
   * edit kind, code, a label) is left alone.
   */
  async unmarked(output: ToolOutput, args: Readonly<Record<string, unknown>>): Promise<void> {
    const policy = await this.policy();
    const editKind = outputEditKind(output, args as Record<string, unknown>);
    const value = args[output.argument];
    const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    if (policy.internal_technical || policy.exempt_edit_kinds.includes(editKind) || isCode(output.mediaType)
      || (typeof value === "string" && isLabel(value, output.mediaType))) return;
    const report: PlacementReport = {
      tool: this.#call.tool.name, sink_kind: "unmarked", media_type: output.mediaType, edit_kind: editKind,
      length_class: lengthClass(text, tokensOf(text, this.#state.options.tokenizer), policy), layers: [],
    };
    let reported = true;
    try {
      await this.#state.backend(this.#call).reportPlacement(report, AbortSignal.timeout(REPORT_TIMEOUT_MS));
    } catch (error) {
      reported = false;
      this.#state.lastReportError = error;
    }
    await this.#call.record(ProvenanceEntryTypes.unmarked, {
      call_id: this.#call.callId, tool: this.#call.tool.name, argument: output.argument, media_type: output.mediaType,
      edit_kind: editKind, length_class: report.length_class, reported,
    });
    if (this.#state.settings.development) {
      throw new ProvenanceUnmarkedError(`'${this.#call.tool.name}' declares content for people in '${output.argument}' and did not `
        + "place it through place(), so it is not marked. Place it with provenanceOf(context).place(...) in the tool.");
    }
  }
}

const warned = new Set<string>();

/** Local policy options that would loosen the server's are ignored, and said so once. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`The provenance module ignores a local policy option that would loosen the server's: ${message}`);
}
