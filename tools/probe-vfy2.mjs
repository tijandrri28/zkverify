// tools/probe-vfy2.mjs — expanded candidate dictionary for the vfy-policy wasm.
// Same FNV-1a probing as probe-signals.mjs, but with a much larger,
// systematically generated candidate list (prefix/suffix combos).
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

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
const wasm = fs.readFileSync(wasmPath);
const wc = await WitnessCalculatorBuilder(wasm, { sanityCheck: false });
wc.instance.exports.init(0);
const total = wc.instance.exports.getInputSize();
console.log(`wasm: ${wasmPath}  total input signals: ${total}`);

const known = new Set(["amount", "salt", "matchId", "turnNumber", "opponentBalance", "action", "commitment", "circuitVersion"]);

const c = new Set();
// balance names
for (const p of ["my", "own", "player", "agent", "self", "current", "myCurrent", "myOwn", "wallet", ""]) {
  for (const s of ["Balance", "Bal", "Funds", "Amount", "Total"]) {
    if (p === "" && s !== "Balance") continue;
    c.add(p + s);
  }
}
// action history
for (const p of ["last", "prev", "previous", "opponent", "opp", "lastOpponent", "previousOpponent", "myLast", "myPrev"]) {
  for (const s of ["Action", "Move", "Outcome", "Result", "Play"]) c.add(p + s);
}
// policy / strategy params
for (const p of ["policy", "strategy", "steal", "fortify", "hold", "extract", "aggression", "defense", "risk"]) {
  for (const s of ["Steal", "Fortify", "Hold", "Extract", "Threshold", "Limit", "Amount", "At", "When", "Rate", "Level", "Params", "Value", "Id", "Version", "Policy", "Strategy", "Tolerance"]) {
    c.add(p + s);
  }
}
// commitment variants
for (const p of ["strategy", "policy", "frozen", "committed", "commitment", "game", "match", "state", "action", "turn", "public"]) {
  for (const s of ["Commitment", "Hash", "Id", "Value", "Salt"]) c.add(p + s);
}
// turn / state / misc
for (const n of ["turnsLeft", "remainingTurns", "totalTurns", "currentTurn", "deadlineBlock", "blockNumber", "currentBlock", "expiryBlock", "roundNumber", "matchRound", "swissRound", "phase", "stage", "nonce", "seed", "secret", "key", "random", "entropy", "publicInputsHash", "inputsHash", "stateHash", "gameHash", "matchHash", "turnHash", "actionHash", "decision", "taskId", "minimum", "publicBalance", "recipient", "conditionRecipient", "maxTransfer", "vkHash", "proofVkHash", "registeredVkHash", "task", "request", "payment", "transfer", "approve", "reject", "extract", "fortify", "hold", "shield", "defense", "attack", "stealth", "bluff", "vault", "pool", "score", "points", "winner", "result", "outcome", "valid", "isValid", "allow", "allowed", "permitted", "proof", "verification", "a", "b", "x", "y", "z", "i", "j", "k", "n", "m", "v", "w", "u", "t", "s", "r", "q", "p", "o", "d", "e", "f", "g", "h", "c"]) c.add(n);

const found = [];
for (const name of c) {
  if (known.has(name)) continue;
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
console.log(`new found: ${found.length}; known 8; total known now ${8 + found.length} of ${total}`);
