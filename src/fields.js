// src/fields.js — encodings from the JSON task/turn envelopes into
// BN128 field elements (decimal strings) for the Circom circuits.
//
// CONFIRMED (by probing the downloaded wasm artifacts):
//   gatekeeper: 13 inputs, all public (nPublic=13 in the vk).
//   vfy-policy: 17 inputs = 9 public + 8 private (nPublic=9 in the vk);
//               the 8 private inputs are strategyParams[0..7].
// ASSUMPTIONS (flagged for practice-mode confirmation, see README):
//   - A 256-bit hash (vk hash) is reduced mod the field prime; snarkjs
//     normalises witness inputs the same way.
//   - taskId / matchId (opaque strings) are encoded as keccak256 mod p.
//   - An Ethereum address is encoded as its 160-bit integer value.
//   - Policy action codes: 0=HOLD, 1=FORTIFY, 2=EXTRACT.
import { ethers } from "ethers";

export const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function field(x) {
  // x may be a hex string, decimal string, number or bigint.
  return (BigInt(x) % FIELD_P).toString();
}

export function hashToField(s) {
  return field(BigInt(ethers.keccak256(ethers.toUtf8Bytes(String(s)))));
}

// CANARY C (2026-11-18) — taskId as raw UTF-8 bytes.
// Hypothesis: the platform may compute its expected public_signals[12]
// from the raw task_id bytes (big-endian BigInt), not from keccak256.
// Used ONLY for taskId in buildCircuitInput; the salt (canary A2) still
// uses hashToField. Reversible: switch the one call site back.
export function rawBytesToField(s) {
  const hex = Buffer.from(String(s), "utf8").toString("hex");
  if (hex === "") return "0";
  return field(BigInt("0x" + hex));
}

export function addressToField(addr) {
  if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`Invalid Ethereum address: ${addr}`);
  }
  return field(addr);
}

export function nonNegativeIntToField(v, name) {
  const n = typeof v === "bigint" ? v : BigInt(v);
  if (n < 0n) throw new Error(`${name} must be >= 0, got ${v}`);
  return n.toString();
}

// Policy action codes (ASSUMPTION — confirm in practice mode).
export const ACTION = { HOLD: 0, FORTIFY: 1, EXTRACT: 2 };
export const ACTION_NAMES = ["HOLD", "FORTIFY", "EXTRACT"];

export function actionCode(name) {
  const code = ACTION[String(name).toUpperCase()];
  if (code === undefined) throw new Error(`Unknown action: ${name}`);
  return code;
}
