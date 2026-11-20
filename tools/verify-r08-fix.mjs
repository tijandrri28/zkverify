// tools/verify-r08-fix.mjs — verify the R08 fix end-to-end through the REAL
// code path (handleGatekeeperTask with a synthetic envelope), asserting:
//   1. decision is APPROVE for the valid fixture (fail-closed logic intact)
//   2. publicSignals[12] == keccak256(task_id) mod p  (taskId back to keccak)
//   3. publicSignals[0] == Poseidon([salt, taskId]) with salt == taskId
//      == keccak256(task_id) mod p  (the measured circuit transform)
//   4. the proof verifies locally against the official vk
// Run: node tools/verify-r08-fix.mjs   (exit 0 = all assertions pass)
import { buildPoseidon } from "circomlibjs";
import { ethers } from "ethers";
import * as snarkjs from "snarkjs";
import fs from "node:fs";
import { handleGatekeeperTask } from "../src/gatekeeper.js";
import { hashToField } from "../src/fields.js";

const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR = "0xDe42000000000000000000000000000000009f01";

const TASK_ID = "gk_24_9d1";
const envelope = {
  type: "proof-gatekeeper",
  task_id: TASK_ID,
  input: {
    registered_vk: VK_HASH,
    proof_vk: VK_HASH,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: "19842201",
    current_block: "19832000",
    recipient: ADDR,
    condition_recipient: ADDR,
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0x" + "ab".repeat(32),
  },
};

const result = await handleGatekeeperTask(envelope);
console.log("decision:", result.decision, "| reason:", result.reason_code);
console.log("proof attached:", result.proof ? "yes" : "NO");
if (result.decision !== "APPROVE") {
  console.error("FAIL: expected APPROVE for the valid fixture");
  process.exit(1);
}
if (!result.proof || !result.public_signals) {
  console.error("FAIL: null proof/signals —", result.proof_error ?? "(no error)");
  process.exit(1);
}

const expectedTaskId = hashToField(TASK_ID);
const poseidon = await buildPoseidon();
const expectedSalt = poseidon.F.toString(
  poseidon([BigInt(expectedTaskId), BigInt(expectedTaskId)]),
);

console.log("signals[12] =", result.public_signals[12]);
console.log("expected     =", expectedTaskId);
console.log("signals[0]  =", result.public_signals[0]);
console.log("expected     =", expectedSalt);

let ok = true;
if (result.public_signals[12] !== expectedTaskId) {
  console.error("FAIL: signals[12] != keccak(task_id)");
  ok = false;
}
if (result.public_signals[0] !== expectedSalt) {
  console.error("FAIL: signals[0] != Poseidon([keccak, keccak])");
  ok = false;
}
const vk = JSON.parse(fs.readFileSync("circuits/gatekeeper_vk.json", "utf8"));
const verified = await snarkjs.groth16.verify(
  vk,
  result.public_signals,
  result.proof,
);
console.log("local snarkjs verify:", verified);
if (!verified) {
  console.error("FAIL: local verification failed");
  ok = false;
}
if (!ok) process.exit(1);
console.log("ALL R08-FIX ASSERTIONS PASSED");
process.exit(0); // circomlibjs workers keep the event loop alive otherwise
