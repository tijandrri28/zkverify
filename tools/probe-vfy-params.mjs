// tools/probe-vfy-params.mjs — test whether strategyParams need a
// structural property (e.g. strictly increasing). If a param set gets
// PAST line 72 (OK, or FAIL at a different line), that set is valid.
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

function base(params, overrides = {}) {
  return {
    matchId: hashToField("m_test_1"),
    turnNumber: "7",
    selfBalance: "100",
    opponentBalance: "80",
    action: "0",
    amount: "0",
    commitment: field(poseidonStr(params)),
    circuitVersion: "1",
    salt: SALT,
    strategyParams: params,
    ...overrides,
  };
}

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

const paramSets = {
  "increasing 1..8": ["1", "2", "3", "4", "5", "6", "7", "8"],
  "increasing 10..80": ["10", "20", "30", "40", "50", "60", "70", "80"],
  "increasing 0..7": ["0", "1", "2", "3", "4", "5", "6", "7"],
  "all 100": ["100", "100", "100", "100", "100", "100", "100", "100"],
  "all 1": ["1", "1", "1", "1", "1", "1", "1", "1"],
  "action codes 0,1,2,0,1,2,0,1": ["0", "1", "2", "0", "1", "2", "0", "1"],
  "decreasing 8..1": ["8", "7", "6", "5", "4", "3", "2", "1"],
  "thresholds 5,10,15,20,25,30,35,40": ["5", "10", "15", "20", "25", "30", "35", "40"],
};

for (const [label, params] of Object.entries(paramSets)) {
  for (const action of [0, 1, 2]) {
    await tryInput(
      `params=${label} action=${action}`,
      base(params, { action: String(action), amount: action === 2 ? "10" : "0" }),
    );
  }
}
