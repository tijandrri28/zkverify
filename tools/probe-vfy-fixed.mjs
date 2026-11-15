// tools/probe-vfy-fixed.mjs — vary each FIXED input one at a time.
// Baseline: matchId=keccak256, turn=7, self=100, opp=80, salt=12345,
// commitment=Poseidon(zeros), version=1, action=0(HOLD), amount=0.
// If a single change flips a FAIL to OK, that input was the blocker.
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
const COMMIT = poseidonStr(ZEROS);

function base(overrides) {
  return {
    matchId: hashToField("m_test_1"),
    turnNumber: "7",
    selfBalance: "100",
    opponentBalance: "80",
    action: "0",
    amount: "0",
    commitment: field(COMMIT),
    circuitVersion: "1",
    salt: "12345",
    strategyParams: ZEROS,
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

await tryInput("baseline", base({}));
await tryInput("matchId=1", base({ matchId: "1" }));
await tryInput("matchId=42", base({ matchId: "42" }));
await tryInput("matchId=0", base({ matchId: "0" }));
await tryInput("balances 100/100", base({ opponentBalance: "100" }));
await tryInput("balances 50/50", base({ selfBalance: "50", opponentBalance: "50" }));
await tryInput("balances 200/200", base({ selfBalance: "200", opponentBalance: "200" }));
await tryInput("salt=0", base({ salt: "0" }));
await tryInput("salt=1", base({ salt: "1" }));
await tryInput("turn=1", base({ turnNumber: "1" }));
await tryInput("turn=0", base({ turnNumber: "0" }));
await tryInput("turn=20", base({ turnNumber: "20" }));
