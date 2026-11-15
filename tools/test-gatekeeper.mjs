// tools/test-gatekeeper.mjs — end-to-end gatekeeper proof test.
// Builds the valid scenario from the official event page, generates a
// Groth16 proof with the official circuit, verifies it locally, and
// exercises the circuit's decision enforcement (a wrong decision must
// fail to produce a witness at all).
import fs from "node:fs";
import crypto from "node:crypto";
import { ethers } from "ethers";
import * as snarkjs from "snarkjs";

const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR = "0xDe42000000000000000000000000000000009f01";

function field(x) {
  // Field element as a decimal string, reduced mod p (what snarkjs does
  // when it normalises witness inputs).
  return (BigInt(x) % FIELD_P).toString();
}
function hashToField(s) {
  return field(BigInt(ethers.keccak256(ethers.toUtf8Bytes(s))));
}

function inputFor(overrides) {
  return {
    registeredVkHash: field(VK_HASH),
    proofVkHash: field(VK_HASH),
    minimum: "1000",
    publicBalance: "1460",
    expiryBlock: "19842201",
    currentBlock: "19832000",
    recipient: field(ADDR),
    conditionRecipient: field(ADDR),
    amount: "500",
    maxTransfer: "1000",
    decision: "1",
    taskId: hashToField("gk_24_9d1"),
    salt: field("0x" + crypto.randomBytes(32).toString("hex")),
    ...overrides,
  };
}

const vk = JSON.parse(fs.readFileSync("circuits/gatekeeper_vk.json", "utf8"));

async function prove(label, input) {
  const t0 = Date.now();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input,
      "circuits/gatekeeper.wasm",
      "circuits/gatekeeper_final.zkey",
    );
    const ms = Date.now() - t0;
    const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
    const proofBytes = Buffer.byteLength(JSON.stringify(proof));
    console.log(
      `${label}: fullProve OK in ${ms}ms, verify=${ok}, proof=${proofBytes} bytes, publicSignals=${publicSignals.length}`,
    );
    console.log(`  publicSignals: [${publicSignals.join(", ")}]`);
    return { proof, publicSignals, ok };
  } catch (e) {
    console.log(`${label}: fullProve FAILED in ${Date.now() - t0}ms: ${String(e.message || e).split("\n")[0]}`);
    return null;
  }
}

console.log("== valid scenario (all checks pass, decision=1) ==");
const valid = await prove("VALID approve", inputFor({}));
if (valid) {
  // Public-signal order (measured): [salt, registeredVkHash, proofVkHash,
  // minimum, publicBalance, expiryBlock, currentBlock, recipient,
  // conditionRecipient, amount, maxTransfer, decision, taskId].
  console.log("  decision public signal (index 11) =", valid.publicSignals[11]);
  console.log("  taskId public signal (index 12) =", valid.publicSignals[12]);
}

console.log("== trap: approve with recipient mismatch (decision=1, must FAIL) ==");
await prove("TRAP approve", inputFor({ conditionRecipient: field("0x1111111111111111111111111111111111111111") }));

console.log("== reject a valid request (decision=0, all checks pass, must FAIL) ==");
await prove("WRONG reject", inputFor({ decision: "0" }));

console.log("== reject the trap (decision=0, recipient mismatch, must SUCCEED) ==");
await prove("CORRECT reject", inputFor({ decision: "0", conditionRecipient: field("0x1111111111111111111111111111111111111111") }));

console.log("== trap: threshold mismatch, reject (must SUCCEED) ==");
await prove("THRESHOLD reject", inputFor({ decision: "0", publicBalance: "500" }));
