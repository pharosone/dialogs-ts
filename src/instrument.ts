/**
 * Sit-on-the-wire instrumentation for provider SDK clients.
 *
 * `wrapOpenAI` / `wrapAnthropic` return a transparent Proxy over an existing
 * OpenAI- or Anthropic-shaped client. Every property and call is forwarded
 * unchanged; only the completion method (`chat.completions.create` /
 * `messages.create`) is instrumented: after each completed call the full
 * transcript is rebuilt from `request.messages + response` and sent to
 * PharosOne as a `sendDialog` snapshot (replace semantics).
 *
 * Design invariants:
 * - Zero hard deps: `openai` / `@anthropic-ai/sdk` are never imported — the
 *   provider client is duck-typed (any object with the right nested method).
 * - Pass-through: the caller receives the provider's exact response object
 *   (and, for `stream: true`, the provider's exact chunks) unchanged.
 * - Zero added latency, never throws: the flush runs from a queued microtask;
 *   PharosOne errors are swallowed with a `console.warn`.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type {
  Message,
  SendDialogParams,
  SendDialogResult,
  ToolCall,
  UpsertAgentParams,
} from "./index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The PharosOne surface the instrumentation needs. `PharosOne` satisfies it;
 * tests can pass any object capturing `sendDialog` calls.
 */
export interface PharosLike {
  sendDialog(params: SendDialogParams): Promise<SendDialogResult>;
  upsertAgent?(params: UpsertAgentParams): Promise<unknown>;
}

export interface InstrumentOptions {
  /** Where snapshots are sent (a `PharosOne` instance or anything sendDialog-shaped). */
  pharos: PharosLike;
  /** The wrapped bot's agent id — fixed at wrap time. */
  agentId: string;
  /**
   * Default session id for calls that carry no per-call `pharosSessionId`
   * and run outside `withPharosSession`. Without it the wrapper falls back
   * to a stable FNV-1a hash of the first user message (best-effort).
   */
  sessionId?: string;
  /**
   * When true, the first flush that sees a system prompt upserts it as the
   * agent description (once per process per agentId). Off by default.
   */
  syncAgent?: boolean;
  /** Invoked from the background flush with the sendDialog result (fast verdict). */
  onResult?: (result: SendDialogResult) => void;
  /** Redaction hook applied to tool argsPreview / resultPreview before sending. */
  redact?: (preview: string) => string;
}

type Provider = "openai" | "anthropic";
type AnyFn = (...args: unknown[]) => unknown;

// ---------------------------------------------------------------------------
// Caps (server-side limits; previews stay well under them)
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 500;
// Server caps message text at 20000 chars — stay strictly under.
const TEXT_MAX = 19_999;
const AGENT_DESCRIPTION_MAX = 2_000;

// ---------------------------------------------------------------------------
// Module state: session scope, pending flushes, one-shot agent sync
// ---------------------------------------------------------------------------

const sessionContext = new AsyncLocalStorage<string>();
const pendingFlushes = new Set<Promise<void>>();
const syncedAgents = new Set<string>();

/**
 * Run `fn` with `sessionId` bound for every wrapped provider call inside it
 * (async continuations included). Per-call `pharosSessionId` still wins.
 */
export function withPharosSession<T>(sessionId: string, fn: () => T): T {
  return sessionContext.run(sessionId, fn);
}

/**
 * Await all pending instrumentation flushes. Intended for tests and graceful
 * shutdown; regular callers never need it (flushes are fire-and-forget).
 */
export async function drainPharos(): Promise<void> {
  while (pendingFlushes.size > 0) {
    await Promise.allSettled(Array.from(pendingFlushes));
  }
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * Wrap an OpenAI-shaped client (anything with `chat.completions.create`,
 * including OpenAI-compatible servers: Ollama, vLLM, OpenRouter, ...).
 * Returns a Proxy forwarding everything; the response is passed through
 * unchanged, `stream: true` included.
 */
export function wrapOpenAI<T extends object>(client: T, options: InstrumentOptions): T {
  return wrapMethodPath(client, ["chat", "completions", "create"], makeInstrumentedCreate("openai", options));
}

/** Wrap an Anthropic-shaped client (anything with `messages.create`). */
export function wrapAnthropic<T extends object>(client: T, options: InstrumentOptions): T {
  return wrapMethodPath(client, ["messages", "create"], makeInstrumentedCreate("anthropic", options));
}

/**
 * Proxy `target`, instrumenting only the method at `path`. All other
 * properties are forwarded; functions are bound to the real client so
 * SDKs relying on `this` (including private class fields) keep working.
 */
function wrapMethodPath<T extends object>(
  target: T,
  path: readonly string[],
  makeWrapped: (original: AnyFn, self: object) => AnyFn,
): T {
  const cache = new Map<PropertyKey, unknown>();
  const head = path[0];
  return new Proxy(target, {
    get(t, prop): unknown {
      const value: unknown = Reflect.get(t, prop);
      if (prop === head) {
        if (path.length === 1 && typeof value === "function") {
          let wrapped = cache.get(prop);
          if (wrapped === undefined) {
            wrapped = makeWrapped(value as AnyFn, t);
            cache.set(prop, wrapped);
          }
          return wrapped;
        }
        if (path.length > 1 && value !== null && typeof value === "object") {
          let wrapped = cache.get(prop);
          if (wrapped === undefined) {
            wrapped = wrapMethodPath(value as object, path.slice(1), makeWrapped);
            cache.set(prop, wrapped);
          }
          return wrapped;
        }
        return value;
      }
      if (typeof value === "function" && prop !== "constructor") {
        let bound = cache.get(prop);
        if (bound === undefined) {
          bound = (value as AnyFn).bind(t);
          cache.set(prop, bound);
        }
        return bound;
      }
      return value;
    },
  });
}

function makeInstrumentedCreate(
  provider: Provider,
  options: InstrumentOptions,
): (original: AnyFn, self: object) => AnyFn {
  return (original, self) =>
    function instrumentedCreate(...args: unknown[]): unknown {
      // Strip the per-call pharosSessionId before forwarding — it must never
      // reach the provider.
      let forwardedArgs = args;
      let perCallSession: string | undefined;
      const first = asRecord(args[0]);
      if (first !== undefined && typeof first.pharosSessionId === "string") {
        perCallSession = first.pharosSessionId;
        const stripped: Record<string, unknown> = { ...first };
        delete stripped.pharosSessionId;
        forwardedArgs = [stripped, ...args.slice(1)];
      }
      const requestBody = asRecord(forwardedArgs[0]) ?? {};
      // Explicit wins: per-call > withPharosSession scope > wrap-time option
      // > stable hash of the first user message (best-effort, documented).
      const sessionId =
        perCallSession ?? sessionContext.getStore() ?? options.sessionId ?? fallbackSessionId(provider, requestBody);

      const handle = (response: unknown): unknown => {
        if (isAsyncIterable(response)) {
          return wrapProviderStream(response, provider, requestBody, sessionId, options);
        }
        scheduleFlush(provider, options, requestBody, sessionId, () => extractResponsePart(provider, response));
        return response;
      };

      const outcome = original.apply(self, forwardedArgs);
      if (isPromiseLike(outcome)) {
        return Promise.resolve(outcome).then(handle);
      }
      return handle(outcome);
    };
}

// ---------------------------------------------------------------------------
// Streaming: yield the provider's exact chunks, accumulate, flush on end
// ---------------------------------------------------------------------------

function wrapProviderStream<S extends AsyncIterable<unknown> & object>(
  stream: S,
  provider: Provider,
  requestBody: Record<string, unknown>,
  sessionId: string,
  options: InstrumentOptions,
): S {
  const seen: unknown[] = [];
  let flushed = false;
  const flushOnce = (): void => {
    if (flushed) return;
    flushed = true;
    scheduleFlush(provider, options, requestBody, sessionId, () =>
      provider === "openai" ? accumulateOpenAIChunks(seen) : accumulateAnthropicEvents(seen),
    );
  };
  const makeIterator = (): AsyncIterator<unknown> => {
    const inner = stream[Symbol.asyncIterator]();
    return {
      async next(): Promise<IteratorResult<unknown>> {
        let result: IteratorResult<unknown>;
        try {
          result = await inner.next();
        } catch (err) {
          flushOnce(); // stream failed: flush what was seen
          throw err;
        }
        if (result.done === true) flushOnce();
        else seen.push(result.value);
        return result;
      },
      async return(value?: unknown): Promise<IteratorResult<unknown>> {
        flushOnce(); // early close (break): flush what was seen
        if (typeof inner.return === "function") return inner.return(value);
        return { done: true, value };
      },
      async throw(err?: unknown): Promise<IteratorResult<unknown>> {
        flushOnce();
        if (typeof inner.throw === "function") return inner.throw(err);
        throw err;
      },
    };
  };
  return new Proxy(stream, {
    get(target, prop): unknown {
      if (prop === Symbol.asyncIterator) return makeIterator;
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? (value as AnyFn).bind(target) : value;
    },
  });
}

/** Rebuild an OpenAI-shaped response message from accumulated stream chunks. */
function accumulateOpenAIChunks(chunks: unknown[]): Record<string, unknown> | undefined {
  let text = "";
  let sawText = false;
  const toolAcc = new Map<number, { id: string | undefined; name: string; args: string }>();
  for (const raw of chunks) {
    const choice = asRecord(asArray(asRecord(raw)?.choices)?.[0]);
    const delta = asRecord(choice?.delta);
    if (delta === undefined) continue;
    if (typeof delta.content === "string") {
      text += delta.content;
      sawText = true;
    }
    for (const tcRaw of asArray(delta.tool_calls) ?? []) {
      const tc = asRecord(tcRaw);
      if (tc === undefined) continue;
      const index = typeof tc.index === "number" ? tc.index : 0;
      let acc = toolAcc.get(index);
      if (acc === undefined) {
        acc = { id: undefined, name: "", args: "" };
        toolAcc.set(index, acc);
      }
      if (typeof tc.id === "string" && tc.id !== "") acc.id = tc.id;
      const fn = asRecord(tc.function);
      if (typeof fn?.name === "string") acc.name += fn.name;
      if (typeof fn?.arguments === "string") acc.args += fn.arguments;
    }
  }
  if (!sawText && toolAcc.size === 0) return undefined;
  const message: Record<string, unknown> = { role: "assistant", content: sawText ? text : null };
  if (toolAcc.size > 0) {
    message.tool_calls = Array.from(toolAcc.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({ id: acc.id, type: "function", function: { name: acc.name, arguments: acc.args } }));
  }
  return message;
}

/** Rebuild Anthropic-shaped response content blocks from accumulated stream events. */
function accumulateAnthropicEvents(events: unknown[]): unknown[] {
  const blocks = new Map<number, Record<string, unknown>>();
  const jsonParts = new Map<number, string>();
  for (const raw of events) {
    const ev = asRecord(raw);
    if (ev === undefined) continue;
    if (ev.type === "content_block_start") {
      const index = typeof ev.index === "number" ? ev.index : blocks.size;
      const start = asRecord(ev.content_block);
      blocks.set(index, start !== undefined ? { ...start } : {});
    } else if (ev.type === "content_block_delta") {
      const index = typeof ev.index === "number" ? ev.index : 0;
      let block = blocks.get(index);
      if (block === undefined) {
        block = {};
        blocks.set(index, block);
      }
      const delta = asRecord(ev.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        if (typeof block.type !== "string") block.type = "text";
        block.text = (typeof block.text === "string" ? block.text : "") + delta.text;
      } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        jsonParts.set(index, (jsonParts.get(index) ?? "") + delta.partial_json);
      }
    }
  }
  return Array.from(blocks.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, block]) => {
      const json = jsonParts.get(index);
      if (json !== undefined && json !== "") {
        try {
          block.input = JSON.parse(json) as unknown;
        } catch {
          block.input = json;
        }
      }
      return block;
    });
}

// ---------------------------------------------------------------------------
// Background flush (fire-and-forget; never throws into the caller)
// ---------------------------------------------------------------------------

function scheduleFlush(
  provider: Provider,
  options: InstrumentOptions,
  requestBody: Record<string, unknown>,
  sessionId: string,
  getResponsePart: () => unknown,
): void {
  const task = (async (): Promise<void> => {
    // Defer everything (even transcript building) off the caller's hot path.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    try {
      const part = getResponsePart();
      const built =
        provider === "openai"
          ? buildOpenAITranscript(requestBody, asRecord(part), options.redact)
          : buildAnthropicTranscript(requestBody, part, options.redact);
      await maybeSyncAgent(options, built.systemPrompt);
      const result = await options.pharos.sendDialog({
        agentId: options.agentId,
        sessionId,
        messages: built.messages,
      });
      if (options.onResult !== undefined) {
        try {
          options.onResult(result);
        } catch (err) {
          warn("onResult callback failed", err);
        }
      }
    } catch (err) {
      warn("flush failed", err);
    }
  })();
  pendingFlushes.add(task);
  void task.finally(() => {
    pendingFlushes.delete(task);
  });
}

async function maybeSyncAgent(options: InstrumentOptions, systemPrompt: string | undefined): Promise<void> {
  if (options.syncAgent !== true || systemPrompt === undefined) return;
  if (syncedAgents.has(options.agentId)) return;
  if (options.pharos.upsertAgent === undefined) return;
  syncedAgents.add(options.agentId);
  try {
    await options.pharos.upsertAgent({
      agentId: options.agentId,
      description: truncate(systemPrompt.trim(), AGENT_DESCRIPTION_MAX),
    });
  } catch (err) {
    warn("upsertAgent failed", err);
  }
}

function warn(what: string, err: unknown): void {
  console.warn(`PharosOne instrumentation: ${what}:`, err);
}

// ---------------------------------------------------------------------------
// Transcript mapping — OpenAI Chat Completions
// ---------------------------------------------------------------------------

interface BuiltTranscript {
  messages: Message[];
  systemPrompt: string | undefined;
}

function extractResponsePart(provider: Provider, response: unknown): unknown {
  if (provider === "openai") {
    return asRecord(asArray(asRecord(response)?.choices)?.[0])?.message;
  }
  return asRecord(response)?.content;
}

function buildOpenAITranscript(
  body: Record<string, unknown>,
  responseMessage: Record<string, unknown> | undefined,
  redact: ((preview: string) => string) | undefined,
): BuiltTranscript {
  const out: Message[] = [];
  const pending = new Map<string, ToolCall>();
  let systemPrompt: string | undefined;

  const append = (m: Record<string, unknown>): void => {
    const role = m.role;
    if (role === "system" || role === "developer") {
      // Feeds the agent description, not the dialog.
      if (systemPrompt === undefined) {
        const text = openaiContentToText(m.content);
        if (text.trim() !== "") systemPrompt = text;
      }
      return;
    }
    if (role === "user") {
      out.push({ role: "user", text: truncate(openaiContentToText(m.content), TEXT_MAX) });
      return;
    }
    if (role === "assistant") {
      const text = openaiContentToText(m.content);
      if (text !== "") out.push({ role: "bot", text: truncate(text, TEXT_MAX) });
      for (const raw of asArray(m.tool_calls) ?? []) {
        const tc = asRecord(raw);
        if (tc === undefined) continue;
        const fn = asRecord(tc.function);
        const name = typeof fn?.name === "string" && fn.name !== "" ? fn.name : "tool";
        const toolCall: ToolCall = { name, label: name, status: "pending" };
        const argsRaw =
          typeof fn?.arguments === "string" ? fn.arguments : fn?.arguments !== undefined ? safeJson(fn.arguments) : undefined;
        const argsPreview = makePreview(argsRaw, redact);
        if (argsPreview !== undefined) toolCall.argsPreview = argsPreview;
        const entry: Message = { role: "tool", text: "", toolCall };
        if (typeof tc.id === "string" && tc.id !== "") {
          entry.messageId = tc.id;
          pending.set(tc.id, toolCall);
        }
        out.push(entry);
      }
      return;
    }
    if (role === "tool") {
      // A tool result: resolve the pending entry in the assistant's position;
      // never emit a separate bare tool-result message.
      const id = typeof m.tool_call_id === "string" ? m.tool_call_id : undefined;
      const toolCall = id !== undefined ? pending.get(id) : undefined;
      if (toolCall === undefined) return; // orphan result — nothing to resolve (best-effort)
      const text = openaiContentToText(m.content);
      toolCall.status = looksLikeError(text) ? "error" : "ok";
      const resultPreview = makePreview(text, redact);
      if (resultPreview !== undefined) toolCall.resultPreview = resultPreview;
      return;
    }
    // Unknown roles: skipped.
  };

  for (const raw of asArray(body.messages) ?? []) {
    const m = asRecord(raw);
    if (m !== undefined) append(m);
  }
  if (responseMessage !== undefined) append(responseMessage);
  return { messages: out, systemPrompt };
}

/** Flatten OpenAI message content: string, or list of parts (vision). */
function openaiContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      const part = asRecord(raw);
      if (part !== undefined && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      } else {
        parts.push("[non-text content]");
      }
    }
    return parts.join("\n");
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

// ---------------------------------------------------------------------------
// Transcript mapping — Anthropic Messages
// ---------------------------------------------------------------------------

function buildAnthropicTranscript(
  body: Record<string, unknown>,
  responseContent: unknown,
  redact: ((preview: string) => string) | undefined,
): BuiltTranscript {
  const out: Message[] = [];
  const pending = new Map<string, ToolCall>();
  let systemPrompt: string | undefined;

  const sys = body.system;
  if (typeof sys === "string") {
    if (sys.trim() !== "") systemPrompt = sys;
  } else if (Array.isArray(sys)) {
    const text = anthropicContentToText(sys);
    if (text.trim() !== "") systemPrompt = text;
  }

  const appendAssistantContent = (content: unknown): void => {
    if (typeof content === "string") {
      if (content !== "") out.push({ role: "bot", text: truncate(content, TEXT_MAX) });
      return;
    }
    let buf: string[] = [];
    const flushBuf = (): void => {
      const text = buf.join("\n");
      if (text !== "") out.push({ role: "bot", text: truncate(text, TEXT_MAX) });
      buf = [];
    };
    for (const raw of asArray(content) ?? []) {
      const b = asRecord(raw);
      if (b === undefined) continue;
      if (b.type === "text" && typeof b.text === "string") {
        buf.push(b.text);
        continue;
      }
      if (b.type === "tool_use") {
        flushBuf();
        const name = typeof b.name === "string" && b.name !== "" ? b.name : "tool";
        const toolCall: ToolCall = { name, label: name, status: "pending" };
        const argsRaw = typeof b.input === "string" ? b.input : b.input !== undefined ? safeJson(b.input) : undefined;
        const argsPreview = makePreview(argsRaw, redact);
        if (argsPreview !== undefined) toolCall.argsPreview = argsPreview;
        const entry: Message = { role: "tool", text: "", toolCall };
        if (typeof b.id === "string" && b.id !== "") {
          entry.messageId = b.id;
          pending.set(b.id, toolCall);
        }
        out.push(entry);
      }
      // Other block types (thinking, ...) are not part of the dialog: skipped.
    }
    flushBuf();
  };

  const appendUserContent = (content: unknown): void => {
    if (typeof content === "string") {
      out.push({ role: "user", text: truncate(content, TEXT_MAX) });
      return;
    }
    const buf: string[] = [];
    let sawUserContent = false;
    for (const raw of asArray(content) ?? []) {
      const b = asRecord(raw);
      if (b === undefined) continue;
      if (b.type === "text" && typeof b.text === "string") {
        buf.push(b.text);
        sawUserContent = true;
        continue;
      }
      if (b.type === "tool_result") {
        const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
        const toolCall = id !== undefined ? pending.get(id) : undefined;
        if (toolCall !== undefined) {
          toolCall.status = b.is_error === true ? "error" : "ok";
          const resultPreview = makePreview(anthropicContentToText(b.content), redact);
          if (resultPreview !== undefined) toolCall.resultPreview = resultPreview;
        }
        continue;
      }
      buf.push("[non-text content]"); // images and other parts
      sawUserContent = true;
    }
    if (sawUserContent) {
      out.push({ role: "user", text: truncate(buf.join("\n"), TEXT_MAX) });
    }
  };

  for (const raw of asArray(body.messages) ?? []) {
    const m = asRecord(raw);
    if (m === undefined) continue;
    if (m.role === "user") appendUserContent(m.content);
    else if (m.role === "assistant") appendAssistantContent(m.content);
  }
  if (responseContent !== undefined && responseContent !== null) {
    appendAssistantContent(responseContent);
  }
  return { messages: out, systemPrompt };
}

/** Flatten Anthropic content: string, or list of blocks (text / other). */
function anthropicContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block !== undefined && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else {
        parts.push("[non-text content]");
      }
    }
    return parts.join("\n");
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> & object {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function makePreview(
  raw: string | undefined,
  redact: ((preview: string) => string) | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  let value = raw;
  if (redact !== undefined) {
    try {
      value = redact(value);
    } catch {
      value = "[redact failed]";
    }
  }
  return truncate(value, PREVIEW_MAX);
}

function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s;
  } catch {
    return String(value);
  }
}

/** Best-effort: does a tool result read like a failure? Default is "ok". */
function looksLikeError(text: string): boolean {
  if (/^\s*(error|exception|traceback)\b/i.test(text)) return true;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const record = asRecord(parsed);
      if (record !== undefined && "error" in record && Boolean(record.error)) return true;
    } catch {
      // Not JSON — fall through.
    }
  }
  return false;
}

/**
 * Session fallback when nothing explicit is set: a stable FNV-1a 64-bit hash
 * of the first user message. Best-effort — identical opening messages share
 * a session; explicit always wins.
 */
function fallbackSessionId(provider: Provider, body: Record<string, unknown>): string {
  let firstUser = "";
  for (const raw of asArray(body.messages) ?? []) {
    const m = asRecord(raw);
    if (m?.role === "user") {
      firstUser = provider === "openai" ? openaiContentToText(m.content) : anthropicContentToText(m.content);
      break;
    }
  }
  return `auto-${fnv1a64(firstUser)}`;
}

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
