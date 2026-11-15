// tools/probe-signals.mjs — discover the input-signal names of a Circom 2.x .wasm
// by probing the wasm's own getInputSignalSize table with FNV-1a hashes.
// The official /build page does not publish the signal names, so the only
// authoritative source is the compiled artifact itself.
// Usage: node tools/probe-signals.mjs <wasm-file>
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

// FNV-1a 64-bit, exactly as circom_runtime computes it (UTF-16 code units,
// offset basis 0xCBF29CE484222325, prime 0x100000001B3, mod 2^64).
function fnvHash(str) {
  const mod = 2n ** 64n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * 0x100000001b3n) % mod;
  }
  const hex = hash.toString(16);
  return "0".repeat(16 - hex.length) + hex;
}

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: node tools/probe-signals.mjs <wasm-file>");
  process.exit(1);
}

const wasm = fs.readFileSync(wasmPath);
const wc = await WitnessCalculatorBuilder(wasm, { sanityCheck: false });
// init() must run before the signal table answers: without it every
// getInputSignalSize call returns 0. (circom_runtime calls init() inside
// _doCalculateWitness before probing.)
wc.instance.exports.init(0);
const total = wc.instance.exports.getInputSize();
console.log(`wasm: ${wasmPath}`);
console.log(`total input signals: ${total}`);

const candidates = [
  // gatekeeper (known, to validate the probe itself)
  "registeredVkHash", "proofVkHash", "minimum", "publicBalance",
  "expiryBlock", "currentBlock", "recipient", "conditionRecipient",
  "amount", "maxTransfer", "decision", "taskId", "salt",
  // vfy-policy: game state
  "matchId", "match", "gameId", "game", "turn", "turnNumber", "turnIndex",
  "round", "step", "phase", "player", "agent", "opponent", "myId", "oppId",
  "agentId", "address", "wallet",
  "myBalance", "opponentBalance", "oppBalance", "balance", "ownBalance",
  "rivalBalance", "balanceA", "balanceB", "previousBalance", "prevBalance",
  "exposedBalance", "exposed", "protected", "fortified",
  // vfy-policy: action
  "action", "move", "choice", "extractAmount", "stealAmount", "cost",
  "fortifyCost", "minExtract", "maxExtract", "extractCap", "cap", "limit",
  "extract", "fortify", "hold",
  // vfy-policy: commitment / policy
  "commitmentHash", "commitment", "frozenCommitment", "strategyCommitment",
  "strategyHash", "policyHash", "policy", "strategy", "params",
  "threshold", "stealThreshold", "fortifyThreshold", "holdThreshold",
  "circuitVersion", "version", "publicInputsHash", "inputsHash", "hash",
  "stateHash", "gameStateHash", "matchIdHash", "turnHash",
  // vfy-policy: misc
  "deadline", "expiry", "nonce", "seed", "secret", "privateSalt",
  "salt", "idempotencyKey", "total", "score", "points", "winner",
  "result", "outcome", "valid", "isValid", "allow", "allowed",
  "permitted", "proof", "verification", "vkHash",
  "minimum", "publicBalance", "recipient", "conditionRecipient",
  "maxTransfer", "taskId", "task", "request", "payment", "transfer",
  "approve", "reject", "decision",
  "shield", "defense", "attack", "stealth", "bluff", "vault", "pool",
];

const found = [];
for (const name of new Set(candidates)) {
  const h = fnvHash(name);
  const hMSB = parseInt(h.slice(0, 8), 16);
  const hLSB = parseInt(h.slice(8, 16), 16);
  let size;
  try {
    size = wc.instance.exports.getInputSignalSize(hMSB, hLSB);
  } catch {
    continue;
  }
  if (size > 0) {
    found.push({ name, size });
    console.log(`FOUND  ${name}  size=${size}`);
  }
}
console.log(`found ${found.length} of ${total} input signals`);
if (found.length < total) {
  console.log("MISSING: some input signals were not in the candidate list.");
}
