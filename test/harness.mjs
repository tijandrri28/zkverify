// test/harness.mjs — local end-to-end test harness.
// Boots the real server (child process) on a test port, then exercises
// both tracks over HTTP with correctly HMAC-signed envelopes, and
// verifies the gatekeeper proof OFFLINE against the exported vk.
// Run: npm test
// A random HMAC secret is generated for the run; nothing real is used.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import * as snarkjs from "snarkjs";

const PORT = 3456;
const SECRET = crypto.randomBytes(32).toString("hex");
const BASE = `http://127.0.0.1:${PORT}`;

function sign(body) {
  return crypto.createHmac("sha256", Buffer.from(SECRET, "hex")).update(body).digest("hex");
}

async function post(path, obj, secret = SECRET) {
  const body = JSON.stringify(obj);
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-games-signature": crypto.createHmac("sha256", Buffer.from(secret, "hex")).update(body).digest("hex"),
    },
    body,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, sig: res.headers.get("x-agent-games-signature") };
}

function verifyResponseSignature(body, sig) {
  const expected = crypto.createHmac("sha256", Buffer.from(SECRET, "hex")).update(body).digest("hex");
  return sig === expected;
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

const server = spawn("node", ["server.js"], {
  env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: SECRET, SEEN_TX_FILE: "/tmp/zkverify-test-seen.json" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => {});
server.stderr.on("data", () => {});

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

try {
  if (!(await waitReady())) throw new Error("server did not become ready");

  // 1. Health check (unauthenticated).
  const health = await fetch(`${BASE}/health`);
  const healthJson = await health.json();
  check("GET /health 200", health.ok && healthJson.status === "ok", `agent=${healthJson.agent}`);

  // 2. Bad HMAC -> 401, no work done.
  const bad = await post("/gatekeeper", { type: "agent-games.proof-gatekeeper.v1" }, "00".repeat(32));
  check("bad HMAC -> 401", bad.status === 401);

  // 3. Gatekeeper valid task -> APPROVE + proof, verified offline.
  const vkHash = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
  const addr = "0xDe42000000000000000000000000000000009f01";
  const validTask = {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: "gk_test_valid",
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
      proof_tx: "0x" + "aa".repeat(32),
    },
  };
  const vk = JSON.parse(fs.readFileSync("circuits/gatekeeper_vk.json", "utf8"));
  const valid = await post("/gatekeeper", validTask);
  check("gatekeeper valid -> 200 + APPROVE", valid.status === 200 && valid.json?.decision === "APPROVE", `reason=${valid.json?.reason_code}`);
  check("gatekeeper valid reason VALID_CONDITION", valid.json?.reason_code === "VALID_CONDITION");
  check("gatekeeper proof attached", Boolean(valid.json?.proof));
  if (valid.json?.proof) {
    const ok = await snarkjs.groth16.verify(vk, valid.json.public_signals, valid.json.proof);
    check("gatekeeper proof verifies offline (snarkjs)", ok === true);
    check("gatekeeper public signals = 13", valid.json.public_signals?.length === 13);
  }
  check("gatekeeper response is HMAC-signed", verifyResponseSignature(JSON.stringify(valid.json), valid.sig));

  // 4. Gatekeeper trap (recipient mismatch) -> REJECT + proof, verified offline.
  const trapTask = {
    ...validTask,
    task_id: "gk_test_trap",
    input: { ...validTask.input, condition_recipient: "0x1111111111111111111111111111111111111111", proof_tx: "0x" + "bb".repeat(32) },
  };
  const trap = await post("/gatekeeper", trapTask);
  check("gatekeeper trap -> REJECT", trap.status === 200 && trap.json?.decision === "REJECT", `reason=${trap.json?.reason_code}`);
  check("gatekeeper trap reason RECIPIENT_MISMATCH", trap.json?.reason_code === "RECIPIENT_MISMATCH");
  if (trap.json?.proof) {
    const ok = await snarkjs.groth16.verify(vk, trap.json.public_signals, trap.json.proof);
    check("gatekeeper trap proof verifies offline (snarkjs)", ok === true);
  }

  // 5. Proof reuse -> second identical proof_tx is REJECT PROOF_REUSED.
  const reuse = await post("/gatekeeper", validTask);
  check("gatekeeper proof reuse -> REJECT PROOF_REUSED", reuse.json?.decision === "REJECT" && reuse.json?.reason_code === "PROOF_REUSED");

  // 6. Steal the VFY turn -> action + shape (proof may be null until the
  //    commitment construction is confirmed in practice mode).
  const turn = await post("/steal-the-vfy", {
    type: "agent-games.steal-the-vfy.v1",
    match_id: "m_test_1",
    turn: 3,
    input: { self_balance: 100, opponent_balance: 80 },
  });
  check("steal turn -> 200 + action", turn.status === 200 && typeof turn.json?.action === "string", `action=${turn.json?.action}`);
  check("steal echoes match_id + turn", turn.json?.match_id === "m_test_1" && turn.json?.turn === 3);
  check("steal idempotency_key unique per turn", turn.json?.idempotency_key === "caramel-m_test_1-turn-3");
  check(
    "steal omits amount for HOLD/FORTIFY, carries it for EXTRACT",
    turn.json?.action === "EXTRACT" ? turn.json?.amount !== undefined : turn.json?.amount === undefined,
  );
  console.log(`  (steal proof: ${turn.json?.proof ? "attached" : "null — expected until practice mode confirms the commitment construction"})`);

  // 7. Unknown envelope type -> 400.
  const unknown = await post("/", { type: "agent-games.something-else.v1" });
  check("unknown envelope type -> 400", unknown.status === 400);
} catch (e) {
  console.log("HARNESS ERROR:", String(e.message || e));
  fail++;
} finally {
  server.kill("SIGTERM");
}

console.log(`\nharness: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
