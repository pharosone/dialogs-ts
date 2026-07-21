import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { PharosOne, PharosOneApiError } from "../dist/index.js";

// Ambient env must not leak into tests that pass explicit options.
delete process.env.PHAROSONE_BASE_URL;
delete process.env.PHAROSONE_API_KEY;

/**
 * Starts a local HTTP server that records every request and responds with
 * the JSON registered for its path (default 200 {}).
 */
function startServer(routes = {}) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: raw === "" ? null : JSON.parse(raw),
        });
        const route = routes[req.url] ?? { status: 200, body: {} };
        res.writeHead(route.status, {
          "content-type": route.contentType ?? "application/json",
        });
        res.end(typeof route.body === "string" ? route.body : JSON.stringify(route.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const AGENT_WIRE = {
  id: "a-1",
  name: "support-bot",
  description: "Helps customers",
  goal: "Resolve issues fast",
  agent_context_json: { tier: "gold" },
  created_at: "2026-07-20T10:00:00Z",
  updated_at: "2026-07-20T11:00:00Z",
};

test("upsertAgent posts snake_case body with auth and maps the response", async () => {
  const srv = await startServer({
    "/api/v1/upsert-agent": { status: 200, body: AGENT_WIRE },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    const agent = await client.upsertAgent({
      agentId: "support-bot",
      name: "support-bot",
      description: "Helps customers",
      goal: "Resolve issues fast",
    });

    assert.equal(srv.requests.length, 1);
    const req = srv.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v1/upsert-agent");
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.equal(req.headers["content-type"], "application/json");
    assert.deepEqual(req.body, {
      agent_id: "support-bot",
      name: "support-bot",
      description: "Helps customers",
      goal: "Resolve issues fast",
    });

    assert.deepEqual(agent, {
      id: "a-1",
      name: "support-bot",
      description: "Helps customers",
      goal: "Resolve issues fast",
      agentContextJson: { tier: "gold" },
      createdAt: "2026-07-20T10:00:00Z",
      updatedAt: "2026-07-20T11:00:00Z",
    });
  } finally {
    await srv.close();
  }
});

test("upsertAgent omits absent optional fields from the wire body", async () => {
  const srv = await startServer({
    "/api/v1/upsert-agent": { status: 200, body: AGENT_WIRE },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    await client.upsertAgent({ agentId: "support-bot" });
    assert.deepEqual(srv.requests[0].body, { agent_id: "support-bot" });
  } finally {
    await srv.close();
  }
});

test("sendMessage serializes ts, tool_call and end_user to the wire contract", async () => {
  const srv = await startServer({
    "/api/v1/send-message": {
      status: 202,
      body: {
        status: "received",
        dialog_id: "d-1",
        message_index: 3,
        created: true,
        flagged: false,
        fast_scan: "ok",
      },
    },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    const result = await client.sendMessage({
      agentId: "support-bot",
      sessionId: "session-42",
      messageId: "toolcall-7",
      role: "tool",
      text: "",
      ts: new Date("2026-07-20T10:00:00.000Z"),
      toolCall: {
        name: "lookup_order",
        label: "Lookup order",
        status: "ok",
        argsPreview: '{"order_id":"A-1001"}',
        resultPreview: "shipped 2026-07-18",
      },
      endUser: {
        externalId: "u-1",
        email: "user@example.com",
        userAgent: "cli/1.0",
      },
    });

    const req = srv.requests[0];
    assert.equal(req.url, "/api/v1/send-message");
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.deepEqual(req.body, {
      agent_id: "support-bot",
      session_id: "session-42",
      message_id: "toolcall-7",
      role: "tool",
      text: "",
      ts: "2026-07-20T10:00:00.000Z",
      tool_call: {
        name: "lookup_order",
        label: "Lookup order",
        status: "ok",
        args_preview: '{"order_id":"A-1001"}',
        result_preview: "shipped 2026-07-18",
      },
      end_user: {
        external_id: "u-1",
        email: "user@example.com",
        user_agent: "cli/1.0",
      },
    });

    assert.deepEqual(result, {
      status: "received",
      dialogId: "d-1",
      messageIndex: 3,
      created: true,
      flagged: false,
      fastScan: "ok",
    });
  } finally {
    await srv.close();
  }
});

test("sendMessage surfaces the fast verdict (flagged + fastScan mapped from fast_scan)", async () => {
  const srv = await startServer({
    "/api/v1/send-message": {
      status: 202,
      body: {
        status: "received",
        dialog_id: "d-1",
        message_index: 1,
        created: true,
        flagged: true,
        fast_scan: "ok",
      },
    },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    const result = await client.sendMessage({
      agentId: "support-bot",
      sessionId: "session-42",
      role: "user",
      text: "ATTACK",
    });
    assert.equal(result.flagged, true);
    assert.equal(result.fastScan, "ok");
  } finally {
    await srv.close();
  }
});

test("sendMessage omits ts, message_id, tool_call and end_user when absent", async () => {
  const srv = await startServer({
    "/api/v1/send-message": {
      status: 202,
      body: { status: "received", dialog_id: "d-1", message_index: 0, created: true },
    },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    await client.sendMessage({
      agentId: "support-bot",
      sessionId: "session-42",
      role: "user",
      text: "Where is my order?",
    });
    assert.deepEqual(srv.requests[0].body, {
      agent_id: "support-bot",
      session_id: "session-42",
      role: "user",
      text: "Where is my order?",
    });
  } finally {
    await srv.close();
  }
});

test("sendDialog serializes the snapshot messages array", async () => {
  const srv = await startServer({
    "/api/v1/send-dialog": {
      status: 202,
      body: { status: "received", dialog_id: "d-2", flagged: false, fast_scan: "failed" },
    },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    const result = await client.sendDialog({
      agentId: "support-bot",
      sessionId: "session-42",
      messages: [
        { role: "user", text: "hi", ts: "2026-07-20T10:00:00+03:00" },
        { role: "bot", text: "hello", ts: new Date("2026-07-20T07:00:05.000Z") },
        {
          role: "tool",
          text: "",
          messageId: "m-3",
          toolCall: { name: "search", label: "Search", status: "pending" },
        },
      ],
      endUser: { externalId: "u-1" },
    });

    const req = srv.requests[0];
    assert.equal(req.url, "/api/v1/send-dialog");
    assert.deepEqual(req.body, {
      agent_id: "support-bot",
      session_id: "session-42",
      messages: [
        { role: "user", text: "hi", ts: "2026-07-20T10:00:00+03:00" },
        { role: "bot", text: "hello", ts: "2026-07-20T07:00:05.000Z" },
        {
          role: "tool",
          text: "",
          message_id: "m-3",
          tool_call: { name: "search", label: "Search", status: "pending" },
        },
      ],
      end_user: { external_id: "u-1" },
    });

    // fast_scan:"failed" must reach the caller as fastScan so it can refuse
    // to treat flagged=false as a clean verdict.
    assert.deepEqual(result, {
      status: "received",
      dialogId: "d-2",
      flagged: false,
      fastScan: "failed",
    });
  } finally {
    await srv.close();
  }
});

const ANALYSIS_WIRE = {
  dialog_id: "d-9",
  status: "flagged",
  analysis_status: "done",
  flagged: true,
  flag: {
    category: "prompt-injection",
    title: "Prompt injection attempt",
    severity: "high",
    summary: "The user tried to override the system prompt.",
    mappings: [
      { framework: "owasp-llm", code: "LLM01", name: "Prompt Injection", detail: null },
    ],
  },
  effectiveness: { score: 42, label: "poor", summary: "Goal not reached." },
};

const ANALYSIS_EXPECTED = {
  dialogId: "d-9",
  status: "flagged",
  analysisStatus: "done",
  flagged: true,
  // Nested flag/effectiveness objects are passed through from the wire as-is.
  flag: ANALYSIS_WIRE.flag,
  effectiveness: ANALYSIS_WIRE.effectiveness,
};

test("getAnalysis by dialogId posts {dialog_id} and maps top-level keys to camelCase", async () => {
  const srv = await startServer({
    "/api/v1/dialog-analysis": { status: 200, body: ANALYSIS_WIRE },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    const analysis = await client.getAnalysis({ dialogId: "d-9" });

    const req = srv.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/v1/dialog-analysis");
    assert.equal(req.headers.authorization, "Bearer test-key");
    assert.deepEqual(req.body, { dialog_id: "d-9" });

    assert.deepEqual(analysis, ANALYSIS_EXPECTED);
  } finally {
    await srv.close();
  }
});

test("getAnalysis by agentId+sessionId posts the session selector only", async () => {
  const srv = await startServer({
    "/api/v1/dialog-analysis": { status: 200, body: ANALYSIS_WIRE },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    const analysis = await client.getAnalysis({ agentId: "support-bot", sessionId: "session-42" });
    assert.deepEqual(srv.requests[0].body, {
      agent_id: "support-bot",
      session_id: "session-42",
    });
    assert.deepEqual(analysis, ANALYSIS_EXPECTED);
  } finally {
    await srv.close();
  }
});

test("getAnalysis rejects invalid selector combinations before any request", async () => {
  const srv = await startServer();
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    await assert.rejects(
      client.getAnalysis({ dialogId: "d-9", agentId: "a", sessionId: "s" }),
      /not both/,
    );
    await assert.rejects(client.getAnalysis({}), /both/);
    await assert.rejects(client.getAnalysis({ agentId: "a" }), /both/);
    await assert.rejects(client.getAnalysis({ sessionId: "s" }), /both/);
    assert.equal(srv.requests.length, 0);
  } finally {
    await srv.close();
  }
});

test("getAnalysis maps a 404 to PharosOneApiError", async () => {
  const srv = await startServer({
    "/api/v1/dialog-analysis": {
      status: 404,
      body: { title: "Not Found", status: 404, detail: "dialog not found" },
    },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    await assert.rejects(client.getAnalysis({ dialogId: "missing" }), (err) => {
      assert.ok(err instanceof PharosOneApiError);
      assert.equal(err.status, 404);
      assert.equal(err.detail, "dialog not found");
      return true;
    });
  } finally {
    await srv.close();
  }
});

test("non-2xx with huma detail JSON maps to PharosOneApiError", async () => {
  const srv = await startServer({
    "/api/v1/send-message": {
      status: 422,
      body: { title: "Unprocessable Entity", status: 422, detail: "validation failed" },
    },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    await assert.rejects(
      client.sendMessage({ agentId: "a", sessionId: "s", role: "user", text: "x" }),
      (err) => {
        assert.ok(err instanceof PharosOneApiError);
        assert.equal(err.status, 422);
        assert.equal(err.detail, "validation failed");
        assert.match(err.message, /422/);
        assert.match(err.message, /validation failed/);
        return true;
      },
    );
  } finally {
    await srv.close();
  }
});

test("non-JSON error body falls back to the raw text as detail", async () => {
  const srv = await startServer({
    "/api/v1/upsert-agent": {
      status: 502,
      contentType: "text/plain",
      body: "bad gateway",
    },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl, apiKey: "test-key" });
    await assert.rejects(client.upsertAgent({ agentId: "a" }), (err) => {
      assert.ok(err instanceof PharosOneApiError);
      assert.equal(err.status, 502);
      assert.equal(err.detail, "bad gateway");
      return true;
    });
  } finally {
    await srv.close();
  }
});

test("constructor falls back to PHAROSONE_BASE_URL / PHAROSONE_API_KEY", async () => {
  const srv = await startServer({
    "/api/v1/send-dialog": {
      status: 202,
      body: { status: "received", dialog_id: "d-3" },
    },
  });
  try {
    process.env.PHAROSONE_BASE_URL = `${srv.baseUrl}/`; // trailing slash must be stripped
    process.env.PHAROSONE_API_KEY = "env-key";
    const client = new PharosOne();
    await client.sendDialog({ agentId: "a", sessionId: "s", messages: [] });

    const req = srv.requests[0];
    assert.equal(req.url, "/api/v1/send-dialog");
    assert.equal(req.headers.authorization, "Bearer env-key");
  } finally {
    delete process.env.PHAROSONE_BASE_URL;
    delete process.env.PHAROSONE_API_KEY;
    await srv.close();
  }
});

test("missing baseUrl throws a clear error", () => {
  delete process.env.PHAROSONE_BASE_URL;
  assert.throws(() => new PharosOne(), /PHAROSONE_BASE_URL/);
});

test("missing apiKey sends no Authorization header", async () => {
  const srv = await startServer({
    "/api/v1/send-dialog": {
      status: 202,
      body: { status: "received", dialog_id: "d-4" },
    },
  });
  try {
    const client = new PharosOne({ baseUrl: srv.baseUrl });
    await client.sendDialog({ agentId: "a", sessionId: "s", messages: [] });
    assert.equal(srv.requests[0].headers.authorization, undefined);
  } finally {
    await srv.close();
  }
});
