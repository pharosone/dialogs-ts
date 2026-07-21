import { test } from "node:test";
import assert from "node:assert/strict";

import { wrapOpenAI, wrapAnthropic, withPharosSession, drainPharos } from "../dist/index.js";

// ---------------------------------------------------------------------------
// Fakes: duck-typed provider clients + a captured PharosOne
// ---------------------------------------------------------------------------

function capturedPharos() {
  const calls = { sendDialog: [], upsertAgent: [] };
  return {
    calls,
    async sendDialog(params) {
      calls.sendDialog.push(params);
      return { status: "received", dialogId: "d-1", flagged: false, fastScan: "ok" };
    },
    async upsertAgent(params) {
      calls.upsertAgent.push(params);
      return { id: params.agentId };
    },
  };
}

function fakeOpenAI(respond) {
  const captured = [];
  return {
    captured,
    apiKey: "sk-test",
    whoami() {
      return this.apiKey;
    },
    embeddings: { create: async () => ({ ok: true }) },
    chat: {
      completions: {
        create: async (...args) => {
          captured.push(args);
          return respond(...args);
        },
      },
    },
  };
}

function fakeAnthropic(respond) {
  const captured = [];
  return {
    captured,
    messages: {
      create: async (...args) => {
        captured.push(args);
        return respond(...args);
      },
    },
  };
}

function chunkStream(chunks) {
  return {
    controller: "ctrl",
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

async function withWarnSpy(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// OpenAI mapping
// ---------------------------------------------------------------------------

test("wrapOpenAI: exact snapshot with a tool_call pending -> ok round-trip", async () => {
  const body = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a support bot." },
      { role: "user", content: "Where is my order A-1001?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup_order", arguments: '{"order_id":"A-1001"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "shipped 2026-07-18" },
    ],
  };
  const response = {
    id: "cmpl-1",
    choices: [{ index: 0, message: { role: "assistant", content: "Your order shipped on 2026-07-18." } }],
  };

  const pharos = capturedPharos();
  const client = fakeOpenAI(() => response);
  const wrapped = wrapOpenAI(client, { pharos, agentId: "support-bot", sessionId: "s-1" });

  const result = await wrapped.chat.completions.create(body);
  assert.equal(result, response); // exact pass-through, same object
  assert.equal(client.captured.length, 1);
  assert.equal(client.captured[0][0], body); // args forwarded untouched (same object)

  await drainPharos();
  assert.equal(pharos.calls.sendDialog.length, 1);
  assert.deepEqual(pharos.calls.sendDialog[0], {
    agentId: "support-bot",
    sessionId: "s-1",
    messages: [
      { role: "user", text: "Where is my order A-1001?" },
      {
        role: "tool",
        text: "",
        messageId: "call_1",
        toolCall: {
          name: "lookup_order",
          label: "lookup_order",
          status: "ok",
          argsPreview: '{"order_id":"A-1001"}',
          resultPreview: "shipped 2026-07-18",
        },
      },
      { role: "bot", text: "Your order shipped on 2026-07-18." },
    ],
  });
});

test("wrapOpenAI: response tool_calls become pending tool entries", async () => {
  const response = {
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_2", type: "function", function: { name: "search", arguments: '{"q":"dogs"}' } },
          ],
        },
      },
    ],
  };
  const pharos = capturedPharos();
  const wrapped = wrapOpenAI(fakeOpenAI(() => response), {
    pharos,
    agentId: "a",
    sessionId: "s-2",
  });
  await wrapped.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "find dogs" }],
  });
  await drainPharos();
  assert.deepEqual(pharos.calls.sendDialog[0].messages, [
    { role: "user", text: "find dogs" },
    {
      role: "tool",
      text: "",
      messageId: "call_2",
      toolCall: { name: "search", label: "search", status: "pending", argsPreview: '{"q":"dogs"}' },
    },
  ]);
});

test("wrapOpenAI: error-looking tool result resolves to status error", async () => {
  const pharos = capturedPharos();
  const wrapped = wrapOpenAI(
    fakeOpenAI(() => ({ choices: [{ message: { role: "assistant", content: "Sorry." } }] })),
    { pharos, agentId: "a", sessionId: "s-3" },
  );
  await wrapped.chat.completions.create({
    messages: [
      { role: "user", content: "look it up" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "Error: order not found" },
    ],
  });
  await drainPharos();
  const toolMsg = pharos.calls.sendDialog[0].messages[1];
  assert.equal(toolMsg.toolCall.status, "error");
  assert.equal(toolMsg.toolCall.resultPreview, "Error: order not found");
});

test("wrapOpenAI: vision content parts join text and mark non-text", async () => {
  const pharos = capturedPharos();
  const wrapped = wrapOpenAI(
    fakeOpenAI(() => ({ choices: [{ message: { role: "assistant", content: "A cat." } }] })),
    { pharos, agentId: "a", sessionId: "s-4" },
  );
  await wrapped.chat.completions.create({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "data:..." } },
        ],
      },
    ],
  });
  await drainPharos();
  assert.deepEqual(pharos.calls.sendDialog[0].messages[0], {
    role: "user",
    text: "What is in this image?\n[non-text content]",
  });
});

// ---------------------------------------------------------------------------
// Anthropic mapping
// ---------------------------------------------------------------------------

test("wrapAnthropic: exact snapshot with tool_use -> tool_result round-trip", async () => {
  const body = {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: "You are a weather bot.",
    messages: [
      { role: "user", content: "What's the weather in Paris?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "22C sunny", is_error: false }],
      },
    ],
  };
  const response = {
    id: "msg_1",
    role: "assistant",
    content: [{ type: "text", text: "It's 22C and sunny." }],
  };

  const pharos = capturedPharos();
  const client = fakeAnthropic(() => response);
  const wrapped = wrapAnthropic(client, { pharos, agentId: "weather-bot", sessionId: "s-5" });

  const result = await wrapped.messages.create(body);
  assert.equal(result, response);
  assert.equal(client.captured[0][0], body);

  await drainPharos();
  assert.deepEqual(pharos.calls.sendDialog[0], {
    agentId: "weather-bot",
    sessionId: "s-5",
    messages: [
      { role: "user", text: "What's the weather in Paris?" },
      { role: "bot", text: "Let me check." },
      {
        role: "tool",
        text: "",
        messageId: "tu_1",
        toolCall: {
          name: "get_weather",
          label: "get_weather",
          status: "ok",
          argsPreview: '{"city":"Paris"}',
          resultPreview: "22C sunny",
        },
      },
      { role: "bot", text: "It's 22C and sunny." },
    ],
  });
});

test("wrapAnthropic: tool_result with is_error resolves to status error", async () => {
  const pharos = capturedPharos();
  const wrapped = wrapAnthropic(
    fakeAnthropic(() => ({ role: "assistant", content: [{ type: "text", text: "Failed." }] })),
    { pharos, agentId: "a", sessionId: "s-6" },
  );
  await wrapped.messages.create({
    messages: [
      { role: "user", content: "check" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_2", name: "check", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_2", content: "boom", is_error: true }],
      },
    ],
  });
  await drainPharos();
  const toolMsg = pharos.calls.sendDialog[0].messages[1];
  assert.equal(toolMsg.toolCall.status, "error");
  assert.equal(toolMsg.toolCall.resultPreview, "boom");
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test("wrapOpenAI streaming: exact chunks pass through, snapshot accumulates text + tool calls", async () => {
  const chunks = [
    { id: "c", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
    { id: "c", choices: [{ index: 0, delta: { content: "lo" } }] },
    {
      id: "c",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "call_9", function: { name: "lookup_order", arguments: '{"order' } }],
          },
        },
      ],
    },
    {
      id: "c",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '_id":"A-7"}' } }] } }],
    },
    { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  const pharos = capturedPharos();
  const wrapped = wrapOpenAI(
    fakeOpenAI((body) => (body.stream ? chunkStream(chunks) : { choices: [] })),
    { pharos, agentId: "a", sessionId: "s-7" },
  );

  const stream = await wrapped.chat.completions.create({
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
  });
  assert.equal(stream.controller, "ctrl"); // non-iterator props pass through

  const seen = [];
  for await (const chunk of stream) seen.push(chunk);
  assert.equal(seen.length, chunks.length);
  for (let i = 0; i < chunks.length; i++) assert.equal(seen[i], chunks[i]); // identity, unchanged

  await drainPharos();
  assert.deepEqual(pharos.calls.sendDialog[0].messages, [
    { role: "user", text: "Hi" },
    { role: "bot", text: "Hello" },
    {
      role: "tool",
      text: "",
      messageId: "call_9",
      toolCall: {
        name: "lookup_order",
        label: "lookup_order",
        status: "pending",
        argsPreview: '{"order_id":"A-7"}',
      },
    },
  ]);
});

test("wrapOpenAI streaming: early break flushes what was seen", async () => {
  const chunks = [
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
  ];
  const pharos = capturedPharos();
  const wrapped = wrapOpenAI(
    fakeOpenAI((body) => (body.stream ? chunkStream(chunks) : {})),
    { pharos, agentId: "a", sessionId: "s-8" },
  );
  const stream = await wrapped.chat.completions.create({
    messages: [{ role: "user", content: "Hi" }],
    stream: true,
  });
  for await (const chunk of stream) {
    void chunk;
    break; // consume only the first chunk
  }
  await drainPharos();
  assert.equal(pharos.calls.sendDialog.length, 1);
  assert.deepEqual(pharos.calls.sendDialog[0].messages, [
    { role: "user", text: "Hi" },
    { role: "bot", text: "Hel" },
  ]);
});

test("wrapAnthropic streaming: events accumulate into text + tool_use blocks", async () => {
  const events = [
    { type: "message_start", message: { role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "H" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "i" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_9", name: "search", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"cats"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_stop" },
  ];
  const pharos = capturedPharos();
  const wrapped = wrapAnthropic(
    fakeAnthropic((body) => (body.stream ? chunkStream(events) : {})),
    { pharos, agentId: "a", sessionId: "s-9" },
  );
  const stream = await wrapped.messages.create({
    messages: [{ role: "user", content: "find cats" }],
    stream: true,
  });
  const seen = [];
  for await (const ev of stream) seen.push(ev);
  assert.equal(seen.length, events.length);
  assert.equal(seen[0], events[0]);

  await drainPharos();
  assert.deepEqual(pharos.calls.sendDialog[0].messages, [
    { role: "user", text: "find cats" },
    { role: "bot", text: "Hi" },
    {
      role: "tool",
      text: "",
      messageId: "tu_9",
      toolCall: { name: "search", label: "search", status: "pending", argsPreview: '{"q":"cats"}' },
    },
  ]);
});

// ---------------------------------------------------------------------------
// Session binding
// ---------------------------------------------------------------------------

test("withPharosSession binds the session for wrapped calls inside the scope", async () => {
  const pharos = capturedPharos();
  const wrapped = wrapOpenAI(
    fakeOpenAI(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] })),
    { pharos, agentId: "a" },
  );
  await withPharosSession("ctx-1", async () => {
    await wrapped.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
  });
  await drainPharos();
  assert.equal(pharos.calls.sendDialog[0].sessionId, "ctx-1");
});

test("per-call pharosSessionId wins and never reaches the provider", async () => {
  const pharos = capturedPharos();
  const client = fakeOpenAI(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  const wrapped = wrapOpenAI(client, { pharos, agentId: "a", sessionId: "wrap-1" });

  await withPharosSession("ctx-1", async () => {
    await wrapped.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      pharosSessionId: "per-call-1",
    });
  });
  await drainPharos();

  assert.equal(pharos.calls.sendDialog[0].sessionId, "per-call-1");
  const forwarded = client.captured[0][0];
  assert.equal("pharosSessionId" in forwarded, false);
  assert.deepEqual(forwarded, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
});

test("wrap-time sessionId is used when no per-call/context session is set", async () => {
  const pharos = capturedPharos();
  const wrapped = wrapAnthropic(
    fakeAnthropic(() => ({ role: "assistant", content: [{ type: "text", text: "ok" }] })),
    { pharos, agentId: "a", sessionId: "wrap-2" },
  );
  await wrapped.messages.create({ messages: [{ role: "user", content: "hi" }] });
  await drainPharos();
  assert.equal(pharos.calls.sendDialog[0].sessionId, "wrap-2");
});

test("fallback session is a stable hash of the first user message", async () => {
  const pharos = capturedPharos();
  const wrapped = wrapOpenAI(
    fakeOpenAI(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] })),
    { pharos, agentId: "a" },
  );
  await wrapped.chat.completions.create({ messages: [{ role: "user", content: "same opener" }] });
  await wrapped.chat.completions.create({
    messages: [
      { role: "user", content: "same opener" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "next turn" },
    ],
  });
  await wrapped.chat.completions.create({ messages: [{ role: "user", content: "different opener" }] });
  await drainPharos();

  const [a, b, c] = pharos.calls.sendDialog.map((p) => p.sessionId);
  assert.match(a, /^auto-[0-9a-f]{16}$/);
  assert.equal(a, b); // stable across calls in the same conversation
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// Fire-and-forget guarantees
// ---------------------------------------------------------------------------

test("a throwing pharos.sendDialog never breaks the wrapped call", async () => {
  const throwingPharos = {
    async sendDialog() {
      throw new Error("pharos down");
    },
  };
  const response = { choices: [{ message: { role: "assistant", content: "still fine" } }] };
  const wrapped = wrapOpenAI(fakeOpenAI(() => response), {
    pharos: throwingPharos,
    agentId: "a",
    sessionId: "s-err",
  });

  let result;
  const warnings = await withWarnSpy(async () => {
    result = await wrapped.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
    await drainPharos();
  });
  assert.equal(result, response);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PharosOne instrumentation: flush failed/);
});

test("onResult receives the sendDialog result from the background flush", async () => {
  const pharos = {
    async sendDialog() {
      return { status: "received", dialogId: "d-9", flagged: true, fastScan: "ok" };
    },
  };
  const results = [];
  const wrapped = wrapOpenAI(
    fakeOpenAI(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] })),
    { pharos, agentId: "a", sessionId: "s-10", onResult: (r) => results.push(r) },
  );
  await wrapped.chat.completions.create({ messages: [{ role: "user", content: "hi" }] });
  await drainPharos();
  assert.deepEqual(results, [{ status: "received", dialogId: "d-9", flagged: true, fastScan: "ok" }]);
});

test("syncAgent upserts the system prompt as description once per process", async () => {
  const pharos = capturedPharos();
  const wrapped = wrapOpenAI(
    fakeOpenAI(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] })),
    { pharos, agentId: "sync-agent-test-unique", sessionId: "s-11", syncAgent: true },
  );
  const body = {
    messages: [
      { role: "system", content: "You are a support bot." },
      { role: "user", content: "hi" },
    ],
  };
  await wrapped.chat.completions.create(body);
  await wrapped.chat.completions.create(body);
  await drainPharos();

  assert.equal(pharos.calls.sendDialog.length, 2);
  assert.deepEqual(pharos.calls.upsertAgent, [
    { agentId: "sync-agent-test-unique", description: "You are a support bot." },
  ]);
});

// ---------------------------------------------------------------------------
// Previews: caps + redact hook
// ---------------------------------------------------------------------------

test("previews are redacted and capped at 500 chars", async () => {
  const pharos = capturedPharos();
  const longArgs = "a".repeat(600);
  const wrapped = wrapOpenAI(
    fakeOpenAI(() => ({ choices: [{ message: { role: "assistant", content: "done" } }] })),
    {
      pharos,
      agentId: "a",
      sessionId: "s-12",
      redact: (preview) => preview.replace("A-1001", "[order]"),
    },
  );
  await wrapped.chat.completions.create({
    messages: [
      { role: "user", content: "order A-1001 please" }, // message text is NOT redacted
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: longArgs } }],
      },
      { role: "tool", tool_call_id: "c1", content: "A-1001 shipped" },
    ],
  });
  await drainPharos();

  const messages = pharos.calls.sendDialog[0].messages;
  assert.equal(messages[0].text, "order A-1001 please");
  const tc = messages[1].toolCall;
  assert.equal(tc.argsPreview.length, 500);
  assert.ok(tc.argsPreview.startsWith("aaa"));
  assert.ok(tc.argsPreview.endsWith("…"));
  assert.equal(tc.resultPreview, "[order] shipped");
});

// ---------------------------------------------------------------------------
// Transparent proxy behavior
// ---------------------------------------------------------------------------

test("wrapper forwards all other properties and methods unchanged", async () => {
  const pharos = capturedPharos();
  const client = fakeOpenAI(() => ({ choices: [] }));
  const wrapped = wrapOpenAI(client, { pharos, agentId: "a", sessionId: "s" });

  assert.equal(wrapped.apiKey, "sk-test");
  assert.equal(wrapped.whoami(), "sk-test"); // `this` stays bound to the real client
  assert.equal(wrapped.embeddings, client.embeddings); // untouched subtree, same object
  assert.deepEqual(await wrapped.embeddings.create(), { ok: true });
  assert.equal(typeof wrapped.chat.completions.create, "function");
  await drainPharos();
});
