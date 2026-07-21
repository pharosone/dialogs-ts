# @pharosone/dialogs

TypeScript SDK for the PharosOne dialogs API: create/update agents, stream
dialog messages one turn at a time (including tool calls), or send full dialog
snapshots.

- ESM, zero runtime dependencies, uses the global `fetch` (Node.js >= 18 or any
  modern browser runtime).
- CamelCase TypeScript API mapped to the snake_case wire contract
  (`message_id`, `tool_call`, `args_preview`, ...).
- Typed errors: non-2xx responses throw `PharosOneApiError { status, detail }`.
- Zero-touch instrumentation: `wrapOpenAI` / `wrapAnthropic` mirror every chat
  call of an existing provider client into PharosOne — no manual send calls.

## Install

```bash
npm install @pharosone/dialogs
```

## Quickstart

```ts
import { PharosOne } from "@pharosone/dialogs";

const client = new PharosOne({
  baseUrl: "https://pharos.example.com", // or set PHAROSONE_BASE_URL
  apiKey: process.env.MY_PHAROS_KEY,     // or set PHAROSONE_API_KEY
  timeoutMs: 15_000,                     // default
});

// Create the agent ahead of time (optional — ingest auto-provisions too).
await client.upsertAgent({
  agentId: "support-bot",
  description: "Customer support bot for the EU storefront",
  goal: "Resolve order issues without escalating to a human",
});

// Stream each turn as it happens.
await client.sendMessage({
  agentId: "support-bot",
  sessionId: "session-42",
  role: "user",
  text: "Where is my order?",
});

const reply = await client.sendMessage({
  agentId: "support-bot",
  sessionId: "session-42",
  role: "bot",
  text: "Let me check that for you.",
});
console.log(reply.dialogId, reply.messageIndex, reply.created);
```

## Instrument an existing client

Already using the OpenAI or Anthropic SDK? Wrap the client once — every
completed chat call is mirrored into PharosOne as a full-dialog snapshot
(`sendDialog`, replace semantics), rebuilt from the request messages plus the
response. Tool calls are captured from the provider's own structures
(pending → ok/error), and `stream: true` is supported: chunks are passed
through to you unchanged and the snapshot is flushed when the stream
finishes (or is closed early).

```ts
import OpenAI from "openai";
import { PharosOne, wrapOpenAI } from "@pharosone/dialogs";

const pharos = new PharosOne({ baseUrl: "https://pharos.example.com" });
const openai = wrapOpenAI(new OpenAI(), { pharos, agentId: "support-bot" });

// Use it exactly as before — the response (or stream) is passed through unchanged.
const completion = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Where is my order A-1001?" }],
});
```

Anthropic works the same way:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "@pharosone/dialogs";

const anthropic = wrapAnthropic(new Anthropic(), { pharos, agentId: "support-bot" });
```

The wrapper duck-types the client through a `Proxy`, so this SDK never
imports `openai` or `@anthropic-ai/sdk` and stays zero-dependency: anything
with a `chat.completions.create` (OpenAI shape) or `messages.create`
(Anthropic shape) method works.

### OpenAI-compatible endpoints (Ollama, vLLM, OpenRouter, ...)

Any server that speaks the OpenAI Chat Completions API is covered by
`wrapOpenAI` — same client class, different `baseURL`:

```ts
const ollama = wrapOpenAI(
  new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" }),
  { pharos, agentId: "local-bot" },
);
```

### Session binding

The provider API has no dialog concept, so the wrapper supplies the PharosOne
`sessionId`. Highest priority first:

1. Per-call `pharosSessionId` in the request object — stripped before the
   request is forwarded; it never reaches the provider. (The providers' own
   TypeScript types don't know the extra key, so cast the params object or
   prefer the scope below.)
2. `withPharosSession(sessionId, fn)` — an `AsyncLocalStorage` scope; every
   wrapped call inside `fn`, including async continuations, uses it.
3. The `sessionId` passed to `wrapOpenAI` / `wrapAnthropic` at wrap time.
4. Fallback: a stable FNV-1a hash of the first user message
   (`auto-<16 hex chars>`) — best-effort, documented behavior: turns of the
   same conversation share a session because chat APIs resend the history.

```ts
import { withPharosSession } from "@pharosone/dialogs";

await withPharosSession("session-42", async () => {
  await openai.chat.completions.create({ model, messages }); // logged as session-42
});
```

### Fire-and-forget

Instrumentation adds no latency and never throws into your call path: the
snapshot is flushed from a queued microtask in the background, and PharosOne
errors are swallowed with a `console.warn`. To react to the synchronous fast
verdict without blocking the hot path, pass `onResult`:

```ts
const openai = wrapOpenAI(new OpenAI(), {
  pharos,
  agentId: "support-bot",
  onResult: (r) => {
    if (r.fastScan === "ok" && r.flagged) alertSecurity(r.dialogId);
  },
});
```

For tests and graceful shutdown, `await drainPharos()` waits for all pending
flushes.

Other options:

- `syncAgent: true` — on the first flush that sees a system prompt, upsert it
  as the agent description (once per process per agent). Off by default.
- `redact: (preview) => string` — runs over tool `argsPreview` /
  `resultPreview` before they are sent. Tool args/results are only ever sent
  as previews, capped at ~500 chars; message text is capped below 20000
  (the server cap).

Notes:

- Transcripts skip `system` / `developer` content — it feeds the agent
  description, not the dialog.
- The wrapped method returns a native `Promise` resolving to the provider's
  exact response object; extra helpers on the provider's custom promise
  class (e.g. OpenAI's `.withResponse()`) are not preserved.
- `withPharosSession` relies on `node:async_hooks`, so the instrumentation
  is Node-oriented (>= 18).

## Check the verdict

Every `sendMessage` / `sendDialog` result carries a synchronous fast verdict:
`flagged` (boolean) and `fastScan` (`"ok" | "failed"`, mapped from the wire's
`fast_scan`). **`fastScan === "failed"` means the scan did not run — there is
NO verdict.** Never treat `flagged === false` as clean in that case.

For the detailed finding (flag category, severity, framework mappings,
effectiveness score), call `getAnalysis`. Select the dialog with
`{ dialogId }` or with `{ agentId, sessionId }` — exactly one form, or the
client throws before making a request:

```ts
const reply = await client.sendMessage({
  agentId: "support-bot",
  sessionId: "session-42",
  role: "bot",
  text: "Sure, here is how...",
});

if (reply.fastScan === "failed") {
  // no verdict — retry / alert, but do NOT assume clean
} else if (reply.flagged) {
  const analysis = await client.getAnalysis({ dialogId: reply.dialogId });
  // equivalent: client.getAnalysis({ agentId: "support-bot", sessionId: "session-42" })
  console.log(analysis.analysisStatus); // "pending" | "running" | "done" | "failed"
  if (analysis.flag) {
    console.log(analysis.flag.severity, analysis.flag.title, analysis.flag.mappings);
  }
  if (analysis.effectiveness) {
    console.log(analysis.effectiveness.score); // 1-100
  }
}
```

`getAnalysis` is synchronous on the server side: it computes the deep
analysis while the request blocks, up to ~75 seconds in the worst case. The
client therefore uses `max(timeoutMs, 90_000)` for this call instead of the
constructor timeout; pass `getAnalysis(params, { timeoutMs: 120_000 })` to
override per call. If the analysis still is not `"done"` when the server's
wait budget runs out, the response reflects the current state (`flag` /
`effectiveness` may be `null`) — calling again retries, including after a
`"failed"` run.

Mapping note: `getAnalysis` maps the **top-level** response keys to camelCase
(`dialogId`, `analysisStatus`, ...); the nested `flag` / `effectiveness`
objects are passed through from the wire as-is, so their field names
(including keys inside `mappings` entries) are the wire names.

## Tool calls

Attach a `toolCall` to a `role: "tool"` message. With a stable `messageId` you
can send the call as `pending` first and patch in the result later — the server
updates the existing row instead of appending a new one:

```ts
// Tool started:
await client.sendMessage({
  agentId: "support-bot",
  sessionId: "session-42",
  role: "tool",
  text: "",
  messageId: "toolcall-7", // idempotent upsert key
  toolCall: {
    name: "lookup_order",
    label: "Lookup order",
    status: "pending",
    argsPreview: '{"order_id":"A-1001"}',
  },
});

// Tool finished — same messageId, row is updated in place:
await client.sendMessage({
  agentId: "support-bot",
  sessionId: "session-42",
  role: "tool",
  text: "",
  messageId: "toolcall-7",
  toolCall: {
    name: "lookup_order",
    label: "Lookup order",
    status: "ok", // "ok" | "denied" | "error" | "pending"
    argsPreview: '{"order_id":"A-1001"}',
    resultPreview: "shipped 2026-07-18, ETA 2026-07-21",
  },
});
```

## Per-turn streaming vs snapshots

- **`sendMessage`** (per turn) — appends one message to the dialog, or updates
  an existing one when `messageId` matches. Use it to keep the cabinet live
  while the conversation is happening, and to patch tool results in later.
- **`sendDialog`** (snapshot) — replaces the entire stored transcript for
  `(agentId, sessionId)` with the given `messages` array. Use it for backfill,
  end-of-session sync, or when wiring per-turn calls into the bot loop is
  impractical.

Do not mix them casually for the same session: a snapshot overwrites everything
previously streamed. A safe pattern is per-turn streaming during the session
plus, optionally, one final authoritative snapshot at the end.

```ts
await client.sendDialog({
  agentId: "support-bot",
  sessionId: "session-42",
  messages: [
    { role: "user", text: "Where is my order?", ts: "2026-07-20T10:00:00Z" },
    { role: "bot", text: "Let me check that for you.", ts: new Date() },
  ],
  endUser: { externalId: "u-1", locale: "en-GB" },
});
```

`ts` accepts a `Date` or an RFC3339 string; omitted timestamps are assigned by
the server on arrival.

## Errors and timeouts

Non-2xx responses throw `PharosOneApiError` with the HTTP `status` and the
server's `detail` message:

```ts
import { PharosOneApiError } from "@pharosone/dialogs";

try {
  await client.sendMessage({ agentId: "a", sessionId: "s", role: "user", text: "hi" });
} catch (err) {
  if (err instanceof PharosOneApiError) {
    console.error(err.status, err.detail);
  } else {
    throw err;
  }
}
```

Requests time out after `timeoutMs` (default 15s) via `AbortSignal.timeout`;
a timed-out request rejects with a `TimeoutError` `DOMException`. Exception:
`getAnalysis` uses `max(timeoutMs, 90_000)` because the server blocks while
computing the analysis (see "Check the verdict").

## Development

```bash
npm install
npm run build   # tsc → dist/ (+ .d.ts)
npm test        # builds, then runs node --test against dist/
```
