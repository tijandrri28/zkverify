// tools/probe-vfy-witness.mjs — diagnostic: compute the vfy-policy
// witness WITHOUT the sanity check (so it does not abort at line 72)
// and inspect it. Goals:
//   1. Read the public-signal order from witness[1..9] (distinct values).
//   2. Confirm strategyParams are actually set (search the witness for
//      the distinct param values 11,22,33,44,55,66,77,88).
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";
import { buildPoseidon } from "circomlibjs";
import { ethers } from "ethers";

const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const field = (x) => (BigInt(x) % FIELD_P).toString();
const hashToField = (s) =>
  field(BigInt(ethers.keccak256(ethers.toUtf8Bytes(s))));

const poseidon = await buildPoseidon();
const poseidonStr = (inputs) =>
  poseidon.F.toString(poseidon(inputs.map((x) => BigInt(x))));

const wasm = fs.readFileSync("circuits/vfy-policy.wasm");
const wc = await WitnessCalculatorBuilder(wasm, { sanityCheck: false });
wc.instance.exports.init(0);

const PARAMS = ["11", "22", "33", "44", "55", "66", "77", "88"];
const SALT = "12345";
const COMMIT = poseidonStr(PARAMS);

const input = {
  matchId: hashToField("m_test_1"),
  turnNumber: "7",
  selfBalance: "100",
  opponentBalance: "80",
  action: "0",
  amount: "0",
  commitment: field(COMMIT),
  circuitVersion: "1",
  salt: SALT,
  strategyParams: PARAMS,
};

console.log("input matchId:", input.matchId);
console.log("input commitment (Poseidon params):", input.commitment);

const witness = await wc.calculateWitness(input, false);
console.log("witness length:", witness.length);
console.log("witness[0] (constant):", witness[0].toString());
console.log("public signals witness[1..9]:");
witness.slice(1, 10).forEach((v, i) => console.log(`  [${i + 1}] ${v.toString()}`));

// Search the whole witness for the distinct param values.
for (const p of PARAMS) {
  const idx = witness.findIndex((v) => v.toString() === p);
  console.log(`strategyParam ${p} found at witness index: ${idx}`);
}
// Search for the commitment and salt too.
console.log("commitment found at witness index:", witness.findIndex((v) => v.toString() === field(COMMIT)));
console.log("salt 12345 found at witness index:", witness.findIndex((v) => v.toString() === "12345"));
console.log("matchId found at witness index:", witness.findIndex((v) => v.toString() === input.matchId));
