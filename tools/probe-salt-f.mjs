// tools/probe-salt-f.mjs — determine the circuit's salt transform f empirically.
// Question: publicSignals[0] = f(salt input). Candidates: Poseidon([salt]),
// Poseidon([salt, taskId]), Poseidon([taskId, salt]), keccak, identity.
// Known measurements (2026-11-16): salt 0 -> 76080195... , salt 1 -> 34163053...
// Those were measured with an UNKNOWN taskId, so first test salt-only candidates,
// then re-measure f(0)/f(1) under a KNOWN taskId and test 2-arity candidates.
import fs from "node:fs";
import { ethers } from "ethers";
import * as snarkjs from "snarkjs";
import { buildPoseidon } from "circomlibjs";

const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const VK_HASH =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const ADDR = "0xDe42000000000000000000000000000000009f01";

const KNOWN_F0 = "7608019542272087659831189020126868494284883966215204818278677573659135050672";
const KNOWN_F1 = "3416305358980223057311285626285120063997304547666749842288853657018704255599";

function field(x) {
  return (BigInt(x) % FIELD_P).toString();
}
function hashToField(s) {
  return field(BigInt(ethers.keccak256(ethers.toUtf8Bytes(s))));
}

const poseidon = await buildPoseidon();
const F = poseidon.F;
const P = (arr) => F.toString(poseidon(arr.map((x) => BigInt(x))));

console.log("== salt-only candidates vs 2026-11-16 measurements ==");
console.log("Poseidon([0]) =", P([0n]), "| match F0?", P([0n]) === KNOWN_F0);
console.log("Poseidon([1]) =", P([1n]), "| match F1?", P([1n]) === KNOWN_F1);
console.log("keccak256(0x00..00) mod p =", hashToField("0x" + "00".repeat(32)));
console.log("identity 0 =", "0", "| identity 1 =", "1");

const vk = JSON.parse(fs.readFileSync("circuits/gatekeeper_vk.json", "utf8"));
const TASK = "gk_24_9d1";
const taskIdHash = hashToField(TASK);
const taskIdRaw = (() => {
  const hex = Buffer.from(TASK, "utf8").toString("hex");
  return field(BigInt("0x" + hex));
})();
console.log("\n== known taskId encodings for", TASK, "==");
console.log("hashToField =", taskIdHash);
console.log("rawBytesToField =", taskIdRaw);

function inputFor(salt, taskId) {
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
    taskId,
    salt,
  };
}

async function measure(label, salt, taskId) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    inputFor(salt, taskId),
    "circuits/gatekeeper.wasm",
    "circuits/gatekeeper_final.zkey",
  );
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  console.log(`\n${label}: verify=${ok} signals[0]=${publicSignals[0]} signals[12]=${publicSignals[12]}`);
  return publicSignals[0];
}

// Re-measure f under a KNOWN taskId (keccak encoding, as in the test harness).
const f0 = await measure("salt=0, taskId=keccak", "0", taskIdHash);
const f1 = await measure("salt=1, taskId=keccak", "1", taskIdHash);

console.log("\n== 2-arity candidates vs re-measured f (taskId=keccak) ==");
console.log("Poseidon([0, taskIdHash]) =", P([0n, BigInt(taskIdHash)]), "| match f0?", P([0n, BigInt(taskIdHash)]) === f0);
console.log("Poseidon([taskIdHash, 0]) =", P([BigInt(taskIdHash), 0n]), "| match f0?", P([BigInt(taskIdHash), 0n]) === f0);
console.log("Poseidon([1, taskIdHash]) =", P([1n, BigInt(taskIdHash)]), "| match f1?", P([1n, BigInt(taskIdHash)]) === f1);
console.log("Poseidon([taskIdHash, 1]) =", P([BigInt(taskIdHash), 1n]), "| match f1?", P([BigInt(taskIdHash), 1n]) === f1);
console.log("Poseidon([0]) == f0?", P([0n]) === f0, "| Poseidon([1]) == f1?", P([1n]) === f1);
