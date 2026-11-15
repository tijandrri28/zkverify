// tools/probe-vfy-final.mjs — last targeted attempts: unusual
// circuitVersion values, and a reordered input object (strategyParams
// first) to test whether the assert depends on key order.
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
const wc = await WitnessCalculatorBuilder(wasm, { sanityCheck: true });
wc.instance.exports.init(0);

const ZEROS = ["0", "0", "0", "0", "0", "0", "0", "0"];
const SALT = "12345";

async function tryInput(label, input) {
  try {
    const witness = await wc.calculateWitness(input, true);
    const pub = witness.slice(1, 10).map((x) => x.toString());
    console.log(`OK   ${label}`);
    console.log(`     public: [${pub.join(", ")}]`);
    return true;
  } catch (e) {
    const line = String(e.message || e).match(/line: (\d+)/)?.[1] ?? "?";
    console.log(`FAIL ${label} (line ${line})`);
    return false;
  }
}

function base(overrides = {}) {
  return {
    matchId: hashToField("m_test_1"),
    turnNumber: "7",
    selfBalance: "100",
    opponentBalance: "80",
    action: "0",
    amount: "0",
    commitment: field(poseidonStr(ZEROS)),
    circuitVersion: "1",
    salt: SALT,
    strategyParams: ZEROS,
    ...overrides,
  };
}

for (const v of ["154", "2026", "20261115", "100", "1000000"]) {
  await tryInput(`circuitVersion=${v}`, base({ circuitVersion: v }));
}

// Reordered keys: strategyParams first.
const reordered = {
  strategyParams: ZEROS,
  salt: SALT,
  circuitVersion: "1",
  commitment: field(poseidonStr(ZEROS)),
  amount: "0",
  action: "0",
  opponentBalance: "80",
  selfBalance: "100",
  turnNumber: "7",
  matchId: hashToField("m_test_1"),
};
await tryInput("reordered keys (strategyParams first)", reordered);

// Poseidon sanity: print Poseidon([1,2]) and Poseidon([0x8]) for the record.
console.log("Poseidon([1,2]) =", poseidonStr(["1", "2"]));
console.log("Poseidon([0 x8]) =", poseidonStr(ZEROS));
