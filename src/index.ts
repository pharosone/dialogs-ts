/**
 * PharosOne dialogs SDK.
 *
 * Zero-dependency ESM client for the PharosOne ingest API: upsert agents,
 * stream dialog messages one turn at a time, send full dialog snapshots, and
 * fetch the detailed dialog analysis on demand. Uses the global `fetch`
 * (Node.js >= 18 or any modern browser runtime).
 *
 * The public surface is camelCase; the SDK maps it to the snake_case wire
 * contract (args_preview, message_id, tool_call, ...) documented in the
 * server OpenAPI spec.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "bot" | "tool";

export type ToolCallStatus = "ok" | "denied" | "error" | "pending";

/** A tool invocation attached to a dialog message. */
export interface ToolCall {
  name: string;
  label: string;
  status: ToolCallStatus;
  argsPreview?: string;
  resultPreview?: string;
}

/** A single dialog message in a send-dialog snapshot. */
export interface Message {
  role: MessageRole;
  text: string;
  /** Client timestamp (Date or RFC3339 string). Omitted: server assigns arrival time. */
  ts?: Date | string;
  /** Idempotent per-message upsert key: re-sending the same id updates the stored row. */
  messageId?: string;
  toolCall?: ToolCall;
}

/** Optional metadata about the human behind the dialog. */
export interface EndUser {
  externalId?: string;
  email?: string;
  name?: string;
  ip?: string;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  referrer?: string;
}

/**
 * Request for POST /api/v1/upsert-agent. `agentId` may be an internal id or a
 * name; unknown agents are created with name = `name ?? agentId`. Omitted
 * optional fields keep the stored values.
 */
export interface UpsertAgentParams {
  agentId: string;
  name?: string;
  description?: string;
  goal?: string;
}

/** The API representation of an agent. */
export interface Agent {
  id: string;
  name: string;
  description: string | null;
  goal: string | null;
  agentContextJson: Record<string, unknown>;
  /** RFC3339 timestamp. */
  createdAt: string;
  /** RFC3339 timestamp. */
  updatedAt: string;
}

/** Request for POST /api/v1/send-message (one message, incremental upsert). */
export interface SendMessageParams {
  agentId: string;
  sessionId: string;
  role: MessageRole;
  text: string;
  /** Client timestamp (Date or RFC3339 string). Omitted: server assigns arrival time. */
  ts?: Date | string;
  /** Idempotent per-message upsert key: re-sending the same id updates the stored row. */
  messageId?: string;
  toolCall?: ToolCall;
  endUser?: EndUser;
}

export interface SendMessageResult {
  status: string;
  dialogId: string;
  /** 0-based index of the written message row. */
  messageIndex: number;
  /** false when messageId matched an existing row (update instead of append). */
  created: boolean;
  /** Synchronous fast verdict for the dialog. Only meaningful when fastScan is "ok". */
  flagged: boolean;
  /** "failed" means the fast scan did not run: there is NO verdict — never treat flagged=false as clean then. */
  fastScan: "ok" | "failed";
}

/** Request for POST /api/v1/send-dialog (full snapshot, replaces the transcript). */
export interface SendDialogParams {
  agentId: string;
  sessionId: string;
  messages: Message[];
  endUser?: EndUser;
}

export interface SendDialogResult {
  status: string;
  dialogId: string;
  /** Synchronous fast verdict for the dialog. Only meaningful when fastScan is "ok". */
  flagged: boolean;
  /** "failed" means the fast scan did not run: there is NO verdict — never treat flagged=false as clean then. */
  fastScan: "ok" | "failed";
}

/**
 * Dialog selector for getAnalysis: either by dialog id, or by the
 * (agentId, sessionId) pair — exactly one form, never both.
 */
export type GetAnalysisParams =
  | { dialogId: string; agentId?: never; sessionId?: never }
  | { dialogId?: never; agentId: string; sessionId: string };

export interface GetAnalysisOptions {
  /**
   * Per-call timeout override in milliseconds. Defaults to
   * max(constructor timeoutMs, 90000): the server computes the analysis
   * while the request blocks (up to ~75s worst case), so the regular
   * request timeout would cut the call short.
   */
  timeoutMs?: number;
}

/**
 * One framework mapping attached to a flag. Passed through from the wire
 * as-is (field names are the wire names).
 */
export interface DialogFlagMapping {
  framework: string;
  code: string;
  name: string;
  detail: string | null;
}

/** The detailed finding attached to a flagged dialog. */
export interface DialogFlag {
  category: string;
  title: string;
  /** "low" | "medium" | "high" */
  severity: string;
  summary: string;
  mappings?: DialogFlagMapping[];
}

/** How well the bot performed in the dialog. */
export interface DialogEffectiveness {
  /** 1-100. */
  score: number;
  label: string;
  summary: string;
}

/**
 * Result of getAnalysis. Top-level keys are mapped to camelCase; the nested
 * `flag` / `effectiveness` objects are passed through from the wire as-is,
 * so their field names (including keys inside `mappings` entries) are the
 * wire (snake_case) names — for the current contract they happen to be
 * single words.
 */
export interface DialogAnalysis {
  dialogId: string;
  /** "live" | "clean" | "flagged" */
  status: string;
  /** "pending" | "running" | "done" | "failed" */
  analysisStatus: string;
  flagged: boolean;
  flag: DialogFlag | null;
  effectiveness: DialogEffectiveness | null;
}

export interface PharosOneOptions {
  /** API origin, e.g. "https://pharos.example.com". Falls back to PHAROSONE_BASE_URL. */
  baseUrl?: string;
  /** Ingest API key, sent as "Authorization: Bearer <key>". Falls back to PHAROSONE_API_KEY. */
  apiKey?: string;
  /** Per-request timeout in milliseconds. Default 15000. */
  timeoutMs?: number;
}

/** Non-2xx API response: the HTTP status plus the server's `detail` string. */
export class PharosOneApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`PharosOne API error ${status}: ${detail}`);
    this.name = "PharosOneApiError";
    this.status = status;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Wire mapping (snake_case JSON contract)
// ---------------------------------------------------------------------------

interface AgentWire {
  id: string;
  name: string;
  description: string | null;
  goal: string | null;
  agent_context_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface SendMessageResponseWire {
  status: string;
  dialog_id: string;
  message_index: number;
  created: boolean;
  flagged: boolean;
  fast_scan: "ok" | "failed";
}

interface SendDialogResponseWire {
  status: string;
  dialog_id: string;
  flagged: boolean;
  fast_scan: "ok" | "failed";
}

interface DialogAnalysisResponseWire {
  dialog_id: string;
  status: string;
  analysis_status: string;
  flagged: boolean;
  flag: DialogFlag | null;
  effectiveness: DialogEffectiveness | null;
}

function toRFC3339(ts: Date | string | undefined): string | undefined {
  if (ts === undefined) return undefined;
  return ts instanceof Date ? ts.toISOString() : ts;
}

function toolCallToWire(tc: ToolCall | undefined): Record<string, unknown> | undefined {
  if (tc === undefined) return undefined;
  return {
    name: tc.name,
    label: tc.label,
    status: tc.status,
    args_preview: tc.argsPreview,
    result_preview: tc.resultPreview,
  };
}

function messageToWire(m: Message): Record<string, unknown> {
  return {
    message_id: m.messageId,
    role: m.role,
    text: m.text,
    ts: toRFC3339(m.ts),
    tool_call: toolCallToWire(m.toolCall),
  };
}

function endUserToWire(u: EndUser | undefined): Record<string, unknown> | undefined {
  if (u === undefined) return undefined;
  return {
    external_id: u.externalId,
    email: u.email,
    name: u.name,
    ip: u.ip,
    user_agent: u.userAgent,
    locale: u.locale,
    timezone: u.timezone,
    referrer: u.referrer,
  };
}

function envVar(name: string): string | undefined {
  // Guarded so browser bundles without a `process` shim don't crash.
  if (typeof process === "undefined" || typeof process.env === "undefined") {
    return undefined;
  }
  return process.env[name];
}

function extractDetail(raw: string, fallback: string): string {
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    if (parsed !== null && typeof parsed === "object" && typeof parsed.detail === "string" && parsed.detail !== "") {
      return parsed.detail;
    }
  } catch {
    // Non-JSON error body: fall through to the raw text.
  }
  return raw !== "" ? raw : fallback;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
// getAnalysis blocks while the server computes the deep analysis (up to ~75s
// worst case), so it needs a longer floor than the regular request timeout.
const ANALYSIS_TIMEOUT_FLOOR_MS = 90_000;

export class PharosOne {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: PharosOneOptions = {}) {
    const baseUrl = options.baseUrl ?? envVar("PHAROSONE_BASE_URL");
    if (baseUrl === undefined || baseUrl === "") {
      throw new Error(
        "PharosOne: baseUrl is required (pass options.baseUrl or set PHAROSONE_BASE_URL)",
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? envVar("PHAROSONE_API_KEY");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Create an agent ahead of time or update its name / description / goal. */
  async upsertAgent(params: UpsertAgentParams): Promise<Agent> {
    const wire = (await this.post("/api/v1/upsert-agent", {
      agent_id: params.agentId,
      name: params.name,
      description: params.description,
      goal: params.goal,
    })) as AgentWire;
    return {
      id: wire.id,
      name: wire.name,
      description: wire.description ?? null,
      goal: wire.goal ?? null,
      agentContextJson: wire.agent_context_json ?? {},
      createdAt: wire.created_at,
      updatedAt: wire.updated_at,
    };
  }

  /** Stream a single dialog message (append, or update when messageId matches). */
  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const wire = (await this.post("/api/v1/send-message", {
      agent_id: params.agentId,
      session_id: params.sessionId,
      message_id: params.messageId,
      role: params.role,
      text: params.text,
      ts: toRFC3339(params.ts),
      tool_call: toolCallToWire(params.toolCall),
      end_user: endUserToWire(params.endUser),
    })) as SendMessageResponseWire;
    return {
      status: wire.status,
      dialogId: wire.dialog_id,
      messageIndex: wire.message_index,
      created: wire.created,
      flagged: wire.flagged,
      fastScan: wire.fast_scan,
    };
  }

  /** Send a full dialog snapshot, replacing the stored transcript for the session. */
  async sendDialog(params: SendDialogParams): Promise<SendDialogResult> {
    const wire = (await this.post("/api/v1/send-dialog", {
      agent_id: params.agentId,
      session_id: params.sessionId,
      messages: params.messages.map(messageToWire),
      end_user: endUserToWire(params.endUser),
    })) as SendDialogResponseWire;
    return {
      status: wire.status,
      dialogId: wire.dialog_id,
      flagged: wire.flagged,
      fastScan: wire.fast_scan,
    };
  }

  /**
   * Fetch the detailed verdict for a dialog, computing it on demand.
   *
   * Select the dialog with `{ dialogId }` or with `{ agentId, sessionId }` —
   * exactly one form; anything else throws before any request is made.
   *
   * The call is synchronous on the server side: it blocks while the deep
   * analysis runs (up to ~75s worst case), so it uses a timeout of
   * max(constructor timeoutMs, 90s) instead of the regular request timeout;
   * pass `options.timeoutMs` to override per call. While `analysisStatus`
   * is not "done", `flag` / `effectiveness` may still be null — call again
   * to retry (a "failed" analysis is retried by the server on the next call).
   */
  async getAnalysis(
    params: GetAnalysisParams,
    options: GetAnalysisOptions = {},
  ): Promise<DialogAnalysis> {
    const { dialogId, agentId, sessionId } = params as {
      dialogId?: string;
      agentId?: string;
      sessionId?: string;
    };
    if (dialogId !== undefined && (agentId !== undefined || sessionId !== undefined)) {
      throw new Error(
        "PharosOne.getAnalysis: pass either { dialogId } or { agentId, sessionId }, not both",
      );
    }
    if (dialogId === undefined && (agentId === undefined || sessionId === undefined)) {
      throw new Error(
        "PharosOne.getAnalysis: pass { dialogId }, or both { agentId, sessionId }",
      );
    }
    const body =
      dialogId !== undefined
        ? { dialog_id: dialogId }
        : { agent_id: agentId, session_id: sessionId };
    const timeoutMs = options.timeoutMs ?? Math.max(this.timeoutMs, ANALYSIS_TIMEOUT_FLOOR_MS);
    const wire = (await this.post(
      "/api/v1/dialog-analysis",
      body,
      timeoutMs,
    )) as DialogAnalysisResponseWire;
    return {
      dialogId: wire.dialog_id,
      status: wire.status,
      analysisStatus: wire.analysis_status,
      flagged: wire.flagged,
      flag: wire.flag ?? null,
      effectiveness: wire.effectiveness ?? null,
    };
  }

  private async post(
    path: string,
    payload: unknown,
    timeoutMs: number = this.timeoutMs,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey !== undefined && this.apiKey !== "") {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    // JSON.stringify drops undefined-valued keys, so omitted optional fields
    // never reach the wire.
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new PharosOneApiError(res.status, extractDetail(raw, res.statusText));
    }
    return raw === "" ? {} : (JSON.parse(raw) as unknown);
  }
}

// ---------------------------------------------------------------------------
// Provider SDK instrumentation (wrapOpenAI / wrapAnthropic)
// ---------------------------------------------------------------------------

export { wrapOpenAI, wrapAnthropic, withPharosSession, drainPharos } from "./instrument.js";
export type { InstrumentOptions, PharosLike } from "./instrument.js";
