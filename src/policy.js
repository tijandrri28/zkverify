// src/policy.js — Steal the VFY strategy ("caramel-balanced-v1") and the
// policy-proof plumbing.
//
// STATUS (2026-11-15, measured locally): the vfy-policy circuit's
// commitment/policy encoding is UNDOCUMENTED and could NOT be satisfied
// offline. The witness generator rejects EVERY input combination tried
// (100+ combos) with the same assert: "VfyPolicyProof_154 line: 72".
// Tried and failed: commitments Poseidon(params), Poseidon(params,salt),
// Poseidon(salt,params), Poseidon(params,version), keccak256 (3 encodings),
// MiMCSponge; circuitVersion 0,1,2,154,2026,20261115,100,1000000; actions
// 0-10 and keccak256(action names); params zeros/increasing/decreasing/
// action-codes/all-100/all-1; matchId keccak256/0/1/42; balances
// 100/80, 100/100, 50/50, 200/200; salt 0/1/12345; turns 0/1/7/20.
// The gatekeeper circuit (same toolchain) works end-to-end, so the
// toolchain is fine — the vfy-policy commitment/policy encoding is the
// blocker. It is only resolvable through the platform: the strategy
// commitment registration (which defines the commitment construction and
// circuitVersion) and a practice turn (which supplies a real envelope
// with the frozen commitment hash). Until then the proof path below is
// BEST-EFFORT: generatePolicyProof attempts the documented-shape proof,
// and handleStealTurn falls back to answering with the action and a null
// proof (the match still runs; the turn is scored as HOLD with no proof)
// rather than timing out. See README "Practice-mode confirmations".
//
// THE STRATEGY (the TODO the field guide leaves to the builder).
// Match: both agents start at 100 VFY, 20 turns. Actions:
//   HOLD    — free, does nothing.
//   FORTIFY — small fixed cost, reduces our exposed balance (defence).
//   EXTRACT — free, takes VFY from the opponent's exposed balance.
//
// "caramel-balanced-v1" is a deterministic, tunable threshold policy:
//   * EXTRACT when the opponent is exposed enough to be worth taking.
//   * FORTIFY when WE are exposed enough to be worth protecting.
//   * HOLD otherwise (preserve resources; never pay for defence we do
//     not need, never steal when there is nothing worth taking).
//   * Late game (turn >= 15): if we are behind, lower the extract
//     threshold and steal aggressively; if we are ahead, protect the lead.
//
// Thresholds are the 8 strategyParams the circuit keeps private — the
// circuit proves the action follows the committed strategy WITHOUT
// revealing the parameters. The parameter ORDER below is OUR convention
// for the commitment; the circuit's own interpretation of the 8 slots is
// UNVERIFIED (see README "Practice-mode confirmations"). The commitment
// is Poseidon(strategyParams) — also an assumption to confirm.
//
// Tunable constants (change them here, re-commit the strategy, and the
// commitment changes with them):
export const STRATEGY = {
  name: "caramel-balanced-v1",
  // strategyParams[0..7] — our convention:
  //   [0] extractThreshold   opponent balance >= this -> EXTRACT
  //   [1] richThreshold      our balance >= this (and opp poor) -> FORTIFY
  //   [2] extractCap         max VFY taken per EXTRACT
  //   [3] lateGameTurn       turn at which late-game rules start
  //   [4] lateExtractThreshold  extract threshold when behind, late game
  //   [5] leadMargin         late game, ahead by >= this -> FORTIFY
  //   [6] reserved (0)
  //   [7] reserved (0)
  params: [20, 50, 25, 15, 10, 15, 0, 0],
  circuitVersion: 1,
};

export function strategyParams() {
  return [...STRATEGY.params];
}

// Commitment of the strategy. The platform requires the commitment to be
// registered BEFORE Swiss Round 1; the same commitment value must appear
// in every turn's policy proof. ASSUMPTION: Poseidon over the 8 params.
// If practice mode shows a different hash, change only this function.
import { buildPoseidon } from "circomlibjs";

let poseidonCache = null;
export async function poseidon(inputs) {
  if (!poseidonCache) poseidonCache = await buildPoseidon();
  return poseidonCache.F.toString(poseidonCache(inputs.map((x) => BigInt(x))));
}

export async function strategyCommitment(params = strategyParams()) {
  return poseidon(params);
}

// ---- decision -------------------------------------------------------------
// state: { turn, selfBalance, opponentBalance }
// The circuit's policy is a function of (turn, selfBalance,
// opponentBalance) only — no action history reaches the circuit.
// Game reading (from the event page's turn-resolution table):
//   EXTRACT is free and has non-negative expected value whenever the
//   opponent holds value (it wins outright vs HOLD, is neutral vs
//   EXTRACT, and loses nothing vs FORTIFY), so take whenever the
//   opponent is rich enough. FORTIFY is for protecting a lead late,
//   or when we are rich and the opponent is poor (nothing to take,
//   but we are the obvious target). HOLD when both are poor.
export function decideAction(state) {
  const turn = Number(state.turn);
  const self = BigInt(state.selfBalance);
  const opp = BigInt(state.opponentBalance);
  const [extractThreshold, richThreshold, extractCap, lateGameTurn, lateExtractThreshold, leadMargin] =
    STRATEGY.params.map((x) => BigInt(x));

  const late = BigInt(turn) >= lateGameTurn;
  const behind = self < opp;
  const ahead = self > opp;
  const lead = self - opp;

  // Late game, behind: steal aggressively at the lowered threshold.
  if (late && behind && opp >= lateExtractThreshold) {
    return { action: "EXTRACT", amount: min(opp, extractCap) };
  }
  // Late game, ahead by a margin: protect the lead.
  if (late && ahead && lead >= leadMargin) {
    return { action: "FORTIFY" };
  }
  // Opponent is rich enough to be worth extracting from.
  if (opp >= extractThreshold) {
    return { action: "EXTRACT", amount: min(opp, extractCap) };
  }
  // We are rich and the opponent is poor: nothing worth taking, but we
  // are the obvious target — fortify.
  if (self >= richThreshold) {
    return { action: "FORTIFY" };
  }
  return { action: "HOLD" };
}

function min(a, b) {
  return a < b ? a : b;
}

// ---- publicInputsHash -------------------------------------------------------
// The platform recomputes this hash independently from the public inputs
// and rejects on mismatch. ASSUMPTION: keccak256 over the 9 public
// signals, each as a 32-byte big-endian value, in the circuit's
// public-signal order (see tools/test-steal.mjs for the measured order).
// If practice mode shows Poseidon or a different order, change only
// this function.
import { ethers } from "ethers";

export function publicInputsHash(publicSignals) {
  const packed = ethers.concat(
    publicSignals.map((s) => ethers.toBeHex(BigInt(s), 32)),
  );
  return ethers.keccak256(packed);
}

export function idempotencyKey(matchId, turn) {
  return `caramel-${matchId}-turn-${turn}`;
}
