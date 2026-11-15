// src/steal.js — Steal the VFY turn handling + policy proof.
//
// The platform pushes a signed turn envelope (balances, frozen
// commitment hash, deadline). We answer with the action chosen by the
// "caramel-balanced-v1" policy (src/policy.js), attach the Groth16
// policy proof (circuitVersion + proof + public_signals), echo matchId
// and turn exactly, and include the publicInputsHash.
//
// Hard rules from the field guide:
//   * NEVER send action.amount for HOLD or FORTIFY (omit the field).
//   * Unique idempotencyKey per turn.
//   * Turn deadline is 5 min; the platform waits ~30s per push. A
//     timeout costs -1/turn, an invalid proof -2/turn — so we ALWAYS
//     answer with the action, and attach the proof only if it generated
//     cleanly (a missing proof is cheaper than a timeout, and the action
//     itself still decides the match: win +18 / draw +9 / loss +3).
//   * The strategy commitment must be registered before Swiss Round 1;
//     the commitment in the turn must match the registered one.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as snarkjs from "snarkjs";
import { config } from "./config.js";
import { STRATEGY, decideAction, strategyCommitment, strategyParams, publicInputsHash, idempotencyKey } from "./policy.js";
import { field, hashToField, actionCode, nonNegativeIntToField } from "./fields.js";

const WASM = path.join(process.cwd(), "circuits", "vfy-policy.wasm");
const ZKEY = path.join(process.cwd(), "circuits", "vfy-policy_final.zkey");
const VK = path.join(process.cwd(), "circuits", "vfy-policy_vk.json");

let vkCache = null;
function verificationKey() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK, "utf8"));
  return vkCache;
}

// The turn envelope's exact field names are not published in the guide
// (only described conceptually), so we read each value from the most
// likely names. If practice mode shows different names, add them here.
function pick(obj, ...names) {
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null) return obj[n];
  return undefined;
}

export function parseTurn(envelope) {
  const input = envelope.input ?? envelope;
  const matchId = pick(envelope, "match_id", "matchId", "match") ?? pick(input, "match_id", "matchId");
  const turn = pick(envelope, "turn", "turn_number", "turnNumber") ?? pick(input, "turn", "turn_number", "turnNumber");
  const selfBalance = pick(input, "self_balance", "selfBalance", "balance", "self") ?? pick(envelope, "self_balance", "selfBalance");
  const opponentBalance = pick(input, "opponent_balance", "opponentBalance", "opponent") ?? pick(envelope, "opponent_balance", "opponentBalance");
  const commitment = pick(input, "commitment", "commitment_hash", "strategy_commitment") ?? pick(envelope, "commitment", "commitment_hash");
  const deadline = pick(envelope, "deadline", "deadline_at", "deadlineAt") ?? pick(input, "deadline", "deadline_at");
  return { matchId, turn, selfBalance, opponentBalance, commitment, deadline };
}

export async function generatePolicyProof(state, action, amount, saltHex) {
  const params = strategyParams();
  const commitment = await strategyCommitment(params);
  const circuitInput = {
    matchId: hashToField(state.matchId),
    turnNumber: nonNegativeIntToField(state.turn, "turn"),
    selfBalance: nonNegativeIntToField(state.selfBalance, "selfBalance"),
    opponentBalance: nonNegativeIntToField(state.opponentBalance, "opponentBalance"),
    action: String(actionCode(action)),
    amount: nonNegativeIntToField(amount ?? 0, "amount"),
    commitment: field(commitment),
    circuitVersion: String(STRATEGY.circuitVersion),
    salt: field(saltHex ?? "0x" + crypto.randomBytes(32).toString("hex")),
    strategyParams: params.map((p) => String(p)),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, WASM, ZKEY);
  const ok = await snarkjs.groth16.verify(verificationKey(), publicSignals, proof);
  if (!ok) throw new Error("local verification of the policy proof failed");
  return { proof, publicSignals, commitment };
}

export async function handleStealTurn(envelope, opts = {}) {
  const state = parseTurn(envelope);
  if (state.matchId === undefined || state.turn === undefined || state.selfBalance === undefined || state.opponentBalance === undefined) {
    throw new Error("steal turn envelope missing matchId/turn/balances");
  }

  const { action, amount } = decideAction(state);

  // If the envelope carries a frozen commitment, it must match ours;
  // a mismatch means the platform is not playing against the strategy
  // we committed — we still answer (a timeout is worse), but we flag it.
  let commitmentMismatch = null;
  const ourCommitment = await strategyCommitment();
  if (state.commitment && String(state.commitment).toLowerCase() !== String(ourCommitment).toLowerCase()) {
    commitmentMismatch = `envelope commitment ${state.commitment} != registered ${ourCommitment}`;
  }

  let proof = null;
  let publicSignals = null;
  let proofError = null;
  try {
    const timeoutMs = opts.timeoutMs ?? config.proofTimeoutMs;
    // Race the proof against the deadline, and CLEAR the timer when the
    // proof settles — otherwise the pending timer keeps the process
    // alive for the full timeout (and leaks a timer per turn).
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`policy fullProve timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      const result = await Promise.race([
        generatePolicyProof(state, action, amount ?? 0),
        timeout,
      ]);
      proof = result.proof;
      publicSignals = result.publicSignals;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    proofError = String(e.message || e);
  }

  // Response: echo matchId + turn EXACTLY; omit amount for HOLD/FORTIFY.
  const response = {
    match_id: state.matchId,
    turn: state.turn,
    action,
    ...(action === "EXTRACT" && amount !== undefined ? { amount: amount.toString() } : {}),
    idempotency_key: idempotencyKey(state.matchId, state.turn),
    strategy: STRATEGY.name,
    proof: proof
      ? {
          circuitVersion: STRATEGY.circuitVersion,
          proof,
          public_signals: publicSignals,
          public_inputs_hash: publicInputsHash(publicSignals),
        }
      : null,
    ...(proofError ? { proof_error: proofError } : {}),
    ...(commitmentMismatch ? { commitment_mismatch: commitmentMismatch } : {}),
  };
  return response;
}
