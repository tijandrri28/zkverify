// src/gatekeeper.js — Proof Gatekeeper decision logic + Groth16 proof.
//
// The platform proves a CONDITION on-chain and asks the agent whether the
// requested action is authorised by that condition. "A proof can verify
// perfectly and still authorise the wrong action" — so we check WHAT was
// proven (the condition fields), not just that a proof exists. The
// circuit then attests that our decision is correct for those fields:
// approving a trap, or rejecting a valid request, makes fullProve FAIL
// (verified locally in tools/test-gatekeeper.mjs).
//
// Trap order (first matching trap wins the reason_code):
//   1. VK_SUBSTITUTION   proof_vk != registered_vk
//   2. PROOF_REUSED      proof_tx already answered (local seen-set)
//   3. EXPIRED_CONDITION current_block > expiry_block
//   4. THRESHOLD_MISMATCH public_balance < minimum
//   5. RECIPIENT_MISMATCH recipient != condition_recipient
//   6. AMOUNT_OVERFLOW   amount > max_transfer
//   7. otherwise APPROVE (reason_code VALID_CONDITION)
//
// Scoring: correct +12, wrong APPROVE -6, wrong REJECT -3, timeout -2,
// missing/invalid proof -2. So a wrong APPROVE is the worst mistake:
// on any uncertainty we REJECT (fail closed).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as snarkjs from "snarkjs";
import { config } from "./config.js";
import {
  field,
  hashToField,
  rawBytesToField,
  addressToField,
  nonNegativeIntToField,
} from "./fields.js";

export const REASON_CODES = {
  VALID_CONDITION: "VALID_CONDITION",
  VK_SUBSTITUTION: "VK_SUBSTITUTION",
  PROOF_REUSED: "PROOF_REUSED",
  EXPIRED_CONDITION: "EXPIRED_CONDITION",
  THRESHOLD_MISMATCH: "THRESHOLD_MISMATCH",
  RECIPIENT_MISMATCH: "RECIPIENT_MISMATCH",
  AMOUNT_OVERFLOW: "AMOUNT_OVERFLOW",
  INVALID_INPUT: "INVALID_INPUT",
  PROOF_FAILED: "PROOF_FAILED",
};

const WASM = path.join(process.cwd(), "circuits", "gatekeeper.wasm");
const ZKEY = path.join(process.cwd(), "circuits", "gatekeeper_final.zkey");
const VK = path.join(process.cwd(), "circuits", "gatekeeper_vk.json");

let vkCache = null;
function verificationKey() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK, "utf8"));
  return vkCache;
}

// ---- seen proof_tx set (PROOF_REUSED) ---------------------------------
let seenCache = null;
function loadSeen() {
  if (seenCache) return seenCache;
  try {
    seenCache = new Set(JSON.parse(fs.readFileSync(config.seenTxFile, "utf8")));
  } catch {
    seenCache = new Set();
  }
  return seenCache;
}
function saveSeen() {
  fs.mkdirSync(path.dirname(config.seenTxFile), { recursive: true });
  fs.writeFileSync(
    config.seenTxFile,
    JSON.stringify([...loadSeen()], null, 2),
    "utf8",
  );
}
export function markProofTxSeen(proofTx) {
  loadSeen().add(proofTx.toLowerCase());
  saveSeen();
}
export function hasSeenProofTx(proofTx) {
  return loadSeen().has(proofTx.toLowerCase());
}

// ---- decision -----------------------------------------------------------
export function decide(input) {
  // input: the task envelope's `input` object. Returns
  // { decision: "APPROVE"|"REJECT", reason_code }.
  const {
    registered_vk,
    proof_vk,
    minimum,
    public_balance,
    expiry_block,
    current_block,
    recipient,
    condition_recipient,
    amount,
    max_transfer,
    proof_tx,
  } = input;

  for (const [name, v] of Object.entries({
    registered_vk,
    proof_vk,
    minimum,
    public_balance,
    expiry_block,
    current_block,
    recipient,
    condition_recipient,
    amount,
    max_transfer,
    proof_tx,
  })) {
    if (v === undefined || v === null || v === "") {
      throw new Error(`gatekeeper input missing field: ${name}`);
    }
  }

  // 1. VK substitution — the proof was made under a different key.
  if (String(registered_vk).toLowerCase() !== String(proof_vk).toLowerCase()) {
    return { decision: "REJECT", reason_code: REASON_CODES.VK_SUBSTITUTION };
  }
  // 2. Proof reuse — the same proof_tx was already answered.
  if (hasSeenProofTx(proof_tx)) {
    return { decision: "REJECT", reason_code: REASON_CODES.PROOF_REUSED };
  }
  // 3. Expired condition.
  if (BigInt(current_block) > BigInt(expiry_block)) {
    return { decision: "REJECT", reason_code: REASON_CODES.EXPIRED_CONDITION };
  }
  // 4. Balance below the required minimum.
  if (BigInt(public_balance) < BigInt(minimum)) {
    return { decision: "REJECT", reason_code: REASON_CODES.THRESHOLD_MISMATCH };
  }
  // 5. Recipient is not the condition's recipient.
  if (String(recipient).toLowerCase() !== String(condition_recipient).toLowerCase()) {
    return { decision: "REJECT", reason_code: REASON_CODES.RECIPIENT_MISMATCH };
  }
  // 6. Amount exceeds the maximum transfer.
  if (BigInt(amount) > BigInt(max_transfer)) {
    return { decision: "REJECT", reason_code: REASON_CODES.AMOUNT_OVERFLOW };
  }
  return { decision: "APPROVE", reason_code: REASON_CODES.VALID_CONDITION };
}

// ---- circuit input ------------------------------------------------------
// CONFIRMED public-signal order (measured from a generated proof,
// tools/test-gatekeeper.mjs):
//   [salt, registeredVkHash, proofVkHash, minimum, publicBalance,
//    expiryBlock, currentBlock, recipient, conditionRecipient, amount,
//    maxTransfer, decision, taskId]
// All 13 inputs are public (nPublic=13 in the vk), including the salt.
// Field encodings (see src/fields.js for the assumptions).
export function buildCircuitInput(input, decision, saltHex) {
  return {
    registeredVkHash: field(input.registered_vk),
    proofVkHash: field(input.proof_vk),
    minimum: nonNegativeIntToField(input.minimum, "minimum"),
    publicBalance: nonNegativeIntToField(input.public_balance, "public_balance"),
    expiryBlock: nonNegativeIntToField(input.expiry_block, "expiry_block"),
    currentBlock: nonNegativeIntToField(input.current_block, "current_block"),
    recipient: addressToField(input.recipient),
    conditionRecipient: addressToField(input.condition_recipient),
    amount: nonNegativeIntToField(input.amount, "amount"),
    maxTransfer: nonNegativeIntToField(input.max_transfer, "max_transfer"),
    decision: decision === "APPROVE" ? "1" : "0",
    // CANARY C (2026-11-18): taskId as raw UTF-8 bytes (see
    // rawBytesToField in src/fields.js). The keccak256 encoding (72df3d8
    // fix) is live but the verified-proofs counter stayed 0, so the
    // platform's expected signals[12] may come from the raw bytes
    // instead. Salt (canary A2) is untouched and still uses hashToField.
    taskId: rawBytesToField(input.task_id ?? input.taskId ?? ""),
    salt: field(saltHex ?? "0x" + crypto.randomBytes(32).toString("hex")),
  };
}

// ---- proof ---------------------------------------------------------------
async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function generateProof(input, decision, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? config.proofTimeoutMs;
  const circuitInput = buildCircuitInput(input, decision, opts.saltHex);
  const { proof, publicSignals } = await withTimeout(
    snarkjs.groth16.fullProve(circuitInput, WASM, ZKEY),
    timeoutMs,
    "gatekeeper fullProve",
  );
  // Local sanity check: never send a proof we have not verified ourselves.
  const ok = await snarkjs.groth16.verify(verificationKey(), publicSignals, proof);
  if (!ok) throw new Error("local verification of the gatekeeper proof failed");
  return { proof, publicSignals };
}

// ---- full task handling ----------------------------------------------------
export async function handleGatekeeperTask(envelope) {
  const input = envelope.input ?? envelope;
  const taskId = envelope.task_id ?? envelope.taskId ?? input.task_id ?? "unknown";
  const proofTx = input.proof_tx ?? "";
  // BUG FIX (2026-11-18): the platform envelope carries task_id at the TOP level; it is NOT inside `input`. buildCircuitInput reads input.task_id, so every real task hashed the EMPTY STRING into public_signals[12] instead of keccak256(task_id). Merge the authoritative envelope task_id into the input used for proving.
  const proofInput = taskId === "unknown" ? input : { ...input, task_id: taskId };

  let decision, reasonCode;
  try {
    ({ decision, reason_code: reasonCode } = decide(input));
  } catch (e) {
    // Malformed envelope: fail closed, never approve on bad input.
    return {
      decision: "REJECT",
      reason_code: REASON_CODES.INVALID_INPUT,
      proof_tx: proofTx,
      task_id: taskId,
      proof: null,
      public_signals: null,
      error: String(e.message || e),
    };
  }

  // Record the proof_tx BEFORE proving, so a retry of the same task is
  // caught as PROOF_REUSED instead of being approved twice.
  if (proofTx) markProofTxSeen(proofTx);

  let proof = null;
  let publicSignals = null;
  let proofError = null;
  try {
    ({ proof, publicSignals } = await generateProof(proofInput, decision, {
      saltHex: optsSalt(envelope),
    }));
  } catch (e) {
    // A missing proof costs -2, but the decision itself still scores if
    // correct — so answer with the decision and a null proof rather than
    // timing out (-2) or, worse, guessing.
    proofError = String(e.message || e);
  }

  return {
    decision,
    reason_code: reasonCode,
    proof_tx: proofTx,
    task_id: taskId,
    proof,
    public_signals: publicSignals,
    ...(proofError ? { proof_error: proofError } : {}),
  };
}

// CANARY A (2026-11-16, R04) — deterministic salt.
// The live verifier may recompute the expected public signals (the Steal
// spec says the platform recomputes hashes from game state it knows). A
// random salt can never match a recomputed value, so the salt must be
// deterministic. NOTE (measured 2026-11-16): public_signals[0] is NOT the
// raw salt — the circuit transforms it deterministically (salt 0 ->
// 7608019542272087659831189020126868494284883966215204818278677573659135050672;
// salt 1 -> 3416305358980223057311285626285120063997304547666749842288853657018704255599),
// so the platform's expected signals[0] is f(its salt) under the same
// transform f. A1 = 0. If A1 fails, A2 = keccak256(task_id) via hashToField.
// Decision logic untouched; proof still verified locally before sending.
const CANARY_SALT_MODE = "task-hash"; // "zero" | "task-hash" | "random"
function optsSalt(envelope) {
  if (CANARY_SALT_MODE === "zero") return "0x" + "00".repeat(32);
  if (CANARY_SALT_MODE === "task-hash") {
    const taskId =
      envelope.task_id ?? envelope.taskId ?? envelope.input?.task_id ?? "";
    return hashToField(taskId);
  }
  return undefined; // random (pre-canary behaviour)
}
