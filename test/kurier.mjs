// test/kurier.mjs — Kurier module tests (offline, no real Kurier).
//
// Scenarios (argv[2]):
//   mock      — in-process mock Kurier server implementing the REAL
//               endpoint shapes (register-vk / submit-proof / job-status
//               with the key in the URL path). Tests the happy path,
//               the 401 path, the slow-server timeout, and the full
//               server wiring (response unchanged, submit fires after
//               the response is sent).
//   dead      — KURIER_BASE_URL points at a closed port. Every Kurier
//               call must return null fast and the gatekeeper answer
//               must be unaffected.
//   disabled  — no KURIER_API_KEY. Kurier is inert; the gatekeeper
//               answer must be unaffected.
// Run all three: npm run test:kurier
// A random HMAC secret is generated for the run; nothing real is used.
import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const SCENARIO = process.argv[2] ?? "mock";
const SECRET = crypto.randomBytes(32).toString("hex");
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

// ---- mock Kurier server (real endpoint shapes) ---------------------------
const seen = [];
let mockMode = "ok"; // ok | unauthorized | slow | slow10
let statusCalls = 0;

function mockHandler(req, res) {
  // A timed-out client may close the socket before we answer (slow
  // mode) — swallow the resulting write error instead of crashing.
  res.on("error", () => {});
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null, body });
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (mockMode === "unauthorized") return send(401, { error: "invalid api key" });
    if (req.method === "POST" && req.url.startsWith("/api/v1/register-vk/")) {
      return send(200, { vkHash: "0x" + "ab".repeat(32) });
    }
    if (req.method === "POST" && req.url.startsWith("/api/v1/submit-proof/")) {
      if (mockMode === "slow") return setTimeout(() => send(200, { jobId: "job-test-1", optimisticVerify: true }), 35000);
      if (mockMode === "slow10") return setTimeout(() => send(200, { jobId: "job-test-1", optimisticVerify: true }), 10000);
      return send(200, { jobId: "job-test-1", optimisticVerify: true });
    }
    if (req.method === "GET" && req.url.startsWith("/api/v1/job-status/")) {
      statusCalls++;
      return send(200, { status: statusCalls === 1 ? "Queued" : "Finalized", jobId: "job-test-1" });
    }
    return send(404, { error: "not found" });
  });
}

let mockServer = null;
let mockPort = 0;
async function startMock() {
  mockServer = http.createServer(mockHandler);
  await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
  mockPort = mockServer.address().port;
}

// ---- env for the module under test (read at import time) ------------------
if (SCENARIO === "mock") {
  await startMock();
  process.env.KURIER_API_KEY = "test-key-123";
  process.env.KURIER_BASE_URL = `http://127.0.0.1:${mockPort}/api/v1`;
} else if (SCENARIO === "dead") {
  process.env.KURIER_API_KEY = "test-key-123";
  process.env.KURIER_BASE_URL = "http://127.0.0.1:9";
} else if (SCENARIO === "disabled") {
  delete process.env.KURIER_API_KEY;
  delete process.env.KURIER_BASE_URL;
} else {
  console.log(`unknown scenario: ${SCENARIO}`);
  process.exit(2);
}
process.env.AGENT_GAMES_HMAC_SECRET = SECRET;

const kurier = await import("../src/kurier.js");

// ---- helpers ---------------------------------------------------------------
function sign(body) {
  return crypto.createHmac("sha256", Buffer.from(SECRET, "utf8")).update(body).digest("hex");
}

async function post(path, obj) {
  const body = JSON.stringify(obj);
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-games-signature": sign(body) },
    body,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, ms: Date.now() - t0 };
}

function validTask(proofTx) {
  const vkHash = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
  const addr = "0xDe42000000000000000000000000000000009f01";
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: `gk_kurier_${SCENARIO}`,
    mode: "live",
    input: {
      registered_vk: vkHash,
      proof_vk: vkHash,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: "19842201",
      current_block: "19832000",
      recipient: addr,
      condition_recipient: addr,
      amount: "500",
      max_transfer: "1000",
      proof_tx: proofTx,
    },
  };
}

function startServer() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    AGENT_GAMES_HMAC_SECRET: SECRET,
    SEEN_TX_FILE: `/tmp/zkverify-kurier-test-seen-${SCENARIO}-${crypto.randomBytes(4).toString("hex")}.json`,
  };
  const server = spawn("node", ["server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  return server;
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// ---- scenario tests ---------------------------------------------------------
try {
  if (SCENARIO === "mock") {
    // 1. Happy path: register returns a vkHash; key is in the path,
    //    no Authorization header is sent, body matches the real API.
    const vk = { protocol: "groth16", curve: "bn128", nPublic: 13 };
    const vkHash = await kurier.registerVerificationKey(vk);
    check("mock register -> vkHash", vkHash === "0x" + "ab".repeat(32), `vkHash=${vkHash}`);
    const reg = seen.find((r) => r.path.includes("/register-vk/"));
    check("mock register: key in URL path", reg?.path === "/api/v1/register-vk/test-key-123", reg?.path);
    check("mock register: no Authorization header", reg?.auth === null);
    check(
      "mock register: body shape",
      reg?.body?.proofType === "groth16" &&
        reg?.body?.proofOptions?.library === "snarkjs" &&
        reg?.body?.proofOptions?.curve === "bn128" &&
        JSON.stringify(reg?.body?.vk) === JSON.stringify(vk),
    );

    // 2. Submit returns a jobId with the real payload shape.
    const out = await kurier.submitProof(vkHash, { pi_a: ["1", "2", "1"] }, ["1", "2"]);
    check("mock submit -> jobId", out?.jobId === "job-test-1" && out?.optimisticVerify === true);
    const sub = seen.find((r) => r.path.includes("/submit-proof/"));
    check("mock submit: key in URL path", sub?.path === "/api/v1/submit-proof/test-key-123", sub?.path);
    check(
      "mock submit: body shape",
      sub?.body?.proofType === "groth16" &&
        sub?.body?.vkRegistered === true &&
        sub?.body?.proofOptions?.library === "snarkjs" &&
        sub?.body?.proofData?.vk === vkHash &&
        Array.isArray(sub?.body?.proofData?.publicSignals),
    );

    // 3. Polling reaches Finalized (Queued first, then Finalized).
    statusCalls = 0;
    const finalStatus = await kurier.pollJobStatus("job-test-1");
    check("mock poll -> Finalized", finalStatus === "Finalized", `status=${finalStatus}`);

    // 4. A 401 from Kurier returns null, never throws.
    mockMode = "unauthorized";
    const unauth = await kurier.submitProof(vkHash, { pi_a: ["1"] }, ["1"]);
    check("mock 401 -> null, no throw", unauth === null);
    mockMode = "ok";

    // 5. A slow Kurier (35s) hits the 30s timeout and returns null.
    // (Kurier's real API takes ~19s even to reject, so the timeout
    // is 30s; a 10s delay now succeeds — see test 5b below.)
    mockMode = "slow";
    const t0 = Date.now();
    const slow = await kurier.submitProof(vkHash, { pi_a: ["1"] }, ["1"]);
    const slowMs = Date.now() - t0;
    check("mock slow (35s) -> null via 30s timeout", slow === null && slowMs >= 29000 && slowMs < 34000, `${slowMs}ms`);

    // 5b. A 10s-slow Kurier now SUCCEEDS (inside the 30s timeout).
    mockMode = "slow10";
    const t0b = Date.now();
    const slow10 = await kurier.submitProof(vkHash, { pi_a: ["1"] }, ["1"]);
    const slow10Ms = Date.now() - t0b;
    check("mock slow (10s) -> jobId inside 30s timeout", slow10?.jobId === "job-test-1" && slow10Ms >= 9000 && slow10Ms < 20000, `${slow10Ms}ms`);
    mockMode = "ok";
  }

  if (SCENARIO === "dead") {
    // Every call against a closed port returns null fast, never throws.
    for (const [name, fn] of [
      ["register", () => kurier.registerVerificationKey({ nPublic: 13 })],
      ["submit", () => kurier.submitProof("0xab", { pi_a: ["1"] }, ["1"])],
      ["job-status", () => kurier.getJobStatus("job-1")],
    ]) {
      const t0 = Date.now();
      const out = await fn();
      check(`dead endpoint: ${name} -> null fast, no throw`, out === null && Date.now() - t0 < 6000, `${Date.now() - t0}ms`);
    }
    check("dead endpoint: kurierEnabled true (key set)", kurier.kurierEnabled() === true);
  }

  if (SCENARIO === "disabled") {
    check("disabled: kurierEnabled false (no key)", kurier.kurierEnabled() === false);
    const reg = await kurier.registerVerificationKey({ nPublic: 13 });
    const sub = await kurier.submitProof("0xab", { pi_a: ["1"] }, ["1"]);
    check("disabled: register/submit -> null immediately", reg === null && sub === null);
  }

  // ---- full-server safety test (all scenarios) ---------------------------
  const server = startServer();
  try {
    if (!(await waitReady())) throw new Error("server did not become ready");
    // Give the background startup vk registration a moment (mock only).
    await new Promise((r) => setTimeout(r, 500));

    const proofTx = "0x" + crypto.randomBytes(32).toString("hex");
    const before = seen.length;
    const ans = await post("/gatekeeper", validTask(proofTx));
    check("server gatekeeper -> 200 + APPROVE", ans.status === 200 && ans.json?.decision === "APPROVE", `reason=${ans.json?.reason_code}`);
    check("server gatekeeper proof attached", Boolean(ans.json?.proof));
    check(
      "server gatekeeper response shape unchanged (no kurier fields)",
      ans.json && !("jobId" in ans.json) && !("kurier" in ans.json) && !("kurierJobId" in ans.json),
      `keys=${Object.keys(ans.json ?? {}).join(",")}`,
    );
    check("server gatekeeper answers fast (<10s) despite Kurier state", ans.ms < 10000, `${ans.ms}ms`);

    if (SCENARIO === "mock") {
      // The submit must fire AFTER the response was sent, in the
      // background — the response is already in hand, the mock should
      // see the submit shortly after.
      let sawSubmit = false;
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (seen.slice(before).some((r) => r.path.includes("/submit-proof/"))) {
          sawSubmit = true;
          break;
        }
      }
      check("server gatekeeper -> Kurier submit fired after response", sawSubmit);
      const sub = seen.slice(before).find((r) => r.path.includes("/submit-proof/"));
      check(
        "server submit carries the real proof + public signals",
        Boolean(sub?.body?.proofData?.proof) && Array.isArray(sub?.body?.proofData?.publicSignals) && sub.body.proofData.publicSignals.length === 13,
      );
    }
  } finally {
    server.kill("SIGTERM");
  }
} catch (e) {
  console.log("KURIER TEST ERROR:", String(e.message || e));
  fail++;
} finally {
  if (mockServer) mockServer.close();
}

console.log(`\nkurier (${SCENARIO}): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
