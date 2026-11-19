// server.js — zkVerify Agent Games agent "caramel".
// Plain long-running HTTP server (Node built-ins only, no framework).
// Listens on 0.0.0.0:$PORT (Railway injects PORT).
//
// Routing:
//   GET  /health          unauthenticated health check (platform preflight)
//   GET  /                agent status (unauthenticated)
//   POST /                dispatch by envelope type (the registered endpoint)
//   POST /gatekeeper      Proof Gatekeeper task (explicit path)
//   POST /steal-the-vfy   Steal the VFY turn (explicit path)
//
// Security: every POST verifies x-agent-games-signature (HMAC-SHA256)
// over the RAW body BEFORE parsing. A bad/missing signature gets 401
// and no work is done. Every response is signed the same way over the
// raw response body. The server refuses to start without the HMAC
// secret (see src/config.js).
import http from "node:http";
import { config, hmacSecretBytes } from "./src/config.js";
import { SIGNATURE_HEADER, signBody, verifySignature } from "./src/hmac.js";
import { handleGatekeeperTask } from "./src/gatekeeper.js";
import { handleStealTurn } from "./src/steal.js";

const SECRET = hmacSecretBytes();

function log(level, msg, extra) {
  const line = { t: new Date().toISOString(), level, msg, ...(extra ?? {}) };
  if (level === "error" || config.logLevel === "info" || config.logLevel === "debug") {
    console.log(JSON.stringify(line));
  }
}

function sendSigned(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    [SIGNATURE_HEADER]: signBody(SECRET, body),
  });
  res.end(body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isGatekeeper(envelope) {
  const t = String(envelope?.type ?? envelope?.task_type ?? "");
  return t.includes("proof-gatekeeper") || t.includes("gatekeeper");
}
function isSteal(envelope) {
  const t = String(envelope?.type ?? envelope?.task_type ?? "");
  return t.includes("steal") || t.includes("vfy");
}

async function handlePost(req, res, path) {
  const raw = await readRawBody(req);
  const sig = req.headers[SIGNATURE_HEADER.toLowerCase()];
  if (!verifySignature(SECRET, raw, sig)) {
    log("error", "bad HMAC signature", { path });
    return sendSigned(res, 401, { error: "invalid signature" });
  }

  let envelope;
  try {
    envelope = JSON.parse(raw.toString("utf8"));
  } catch {
    log("error", "invalid JSON body", { path });
    return sendSigned(res, 400, { error: "invalid JSON" });
  }

  // Preflight: the platform sends {"type":"agent-games.preflight.v1"} when
  // an endpoint is saved and expects {ok:true, protocolVersion:"v1"} back,
  // signed. Without this the preflight falls through to "unknown task type".
  const envelopeType = String(envelope?.type ?? envelope?.task_type ?? "");
  if (envelopeType === "agent-games.preflight.v1" || envelopeType === "preflight") {
    log("info", "preflight answered", { path });
    return sendSigned(res, 200, { ok: true, protocolVersion: "v1" });
  }

  // Dispatch: explicit path wins, otherwise the envelope type decides.
  const wantGatekeeper =
    path === "/gatekeeper" || (path === "/" && isGatekeeper(envelope));
  const wantSteal =
    path === "/steal-the-vfy" || path === "/steal" || (path === "/" && isSteal(envelope));

  if (wantGatekeeper) {
    const started = Date.now();
    try {
      const result = await handleGatekeeperTask(envelope);
      log("info", "gatekeeper answered", {
        task_id: result.task_id,
        decision: result.decision,
        reason_code: result.reason_code,
        proof: result.proof ? "attached" : "null",
        ms: Date.now() - started,
      });
      sendSigned(res, 200, result);
      // Proof travels in the response only; the platform verifies it
      // offline. (Kurier submission was removed 2026-11-19.)
      return;
    } catch (e) {
      // Never let a handler exception become a timeout: fail closed.
      log("error", "gatekeeper handler error", { error: String(e.message || e) });
      return sendSigned(res, 200, {
        decision: "REJECT",
        reason_code: "INVALID_INPUT",
        proof_tx: envelope?.input?.proof_tx ?? "",
        task_id: envelope?.task_id ?? "unknown",
        proof: null,
        public_signals: null,
        error: String(e.message || e),
      });
    }
  }

  if (wantSteal) {
    const started = Date.now();
    try {
      const result = await handleStealTurn(envelope);
      log("info", "steal turn answered", {
        match_id: result.match_id,
        turn: result.turn,
        action: result.action,
        proof: result.proof ? "attached" : "null",
        ms: Date.now() - started,
      });
      return sendSigned(res, 200, result);
    } catch (e) {
      log("error", "steal handler error", { error: String(e.message || e) });
      // A turn with no response is a timeout (-1) AND a forced HOLD.
      // Answering HOLD explicitly is at worst the same, and keeps the
      // agent reachable for health checks.
      return sendSigned(res, 200, {
        match_id: envelope?.match_id ?? envelope?.input?.match_id ?? "unknown",
        turn: envelope?.turn ?? envelope?.input?.turn ?? 0,
        action: "HOLD",
        idempotency_key: `caramel-${envelope?.match_id ?? "unknown"}-turn-${envelope?.turn ?? 0}-fallback`,
        strategy: config.strategyName,
        proof: null,
        error: String(e.message || e),
      });
    }
  }

  log("error", "unknown envelope type", { path, type: envelope?.type });
  return sendSigned(res, 400, { error: "unknown task type" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    return sendSigned(res, 200, {
      status: "ok",
      agent: config.agentName,
      tracks: ["proof-gatekeeper", "steal-the-vfy"],
      strategy: config.strategyName,
      time: new Date().toISOString(),
    });
  }
  if (req.method === "POST" && (path === "/" || path === "/gatekeeper" || path === "/steal-the-vfy" || path === "/steal")) {
    return handlePost(req, res, path);
  }
  return sendSigned(res, 404, { error: "not found" });
});

server.listen(config.port, config.host, () => {
  log("info", "agent listening", {
    host: config.host,
    port: config.port,
    agent: config.agentName,
    strategy: config.strategyName,
  });
});

// Graceful shutdown (Railway sends SIGTERM on redeploy).
process.on("SIGTERM", () => {
  log("info", "SIGTERM received, shutting down");
  server.close(() => process.exit(0));
});
