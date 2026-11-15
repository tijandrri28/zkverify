// tools/probe-vfy-commitment.mjs — determine how the vfy-policy circuit
// binds `commitment` to `strategyParams`, and read the public-signal
// order from the witness.
//
// Method: calculateWitness with sanityCheck=true (fast constraint check,
// no proving). Try commitment candidates for a HOLD action with
// all-zero strategyParams. The witness is [1, ...public(9), ...private];
// public signals are witness[1..9].
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

const SALT = "12345";
const PARAMS = ["0", "0", "0", "0", "0", "0", "0", "0"];

const candidates = {
  "commitment=0 (unconstrained?)": "0",
  "Poseidon(params)": poseidonStr(PARAMS),
  "Poseidon(params, salt)": poseidonStr([...PARAMS, SALT]),
  "Poseidon(salt, params)": poseidonStr([SALT, ...PARAMS]),
  "keccak256(params as 32-byte BE) mod p": field(
    BigInt(
      ethers.keccak256(
        ethers.concat(PARAMS.map((p) => ethers.toBeHex(BigInt(p), 32))),
      ),
    ),
  ),
};

function baseInput(commitment, action) {
  return {
    matchId: hashToField("m_test_1"),
    turnNumber: "7",
    selfBalance: "100",
    opponentBalance: "80",
    action: String(action),
    amount: "0",
    commitment: field(commitment),
    circuitVersion: "1",
    salt: SALT,
    strategyParams: PARAMS,
  };
}

for (const [label, commitment] of Object.entries(candidates)) {
  for (const action of [0]) {
    const input = baseInput(commitment, action);
    try {
      const witness = await wc.calculateWitness(input, true);
      const pub = witness.slice(1, 10).map((x) => x.toString());
      console.log(`OK   ${label}  action=${action}`);
      console.log(`     public signals (witness[1..9]): [${pub.join(", ")}]`);
      console.log(`     matchId input was ${input.matchId}`);
      console.log(`     commitment input was ${field(commitment)}`);
    } catch (e) {
      console.log(`FAIL ${label}  action=${action}: ${String(e.message || e).split("\n")[0]}`);
    }
  }
}
