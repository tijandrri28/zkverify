// tools/probe-vfy-grid.mjs — isolate what the vfy-policy circuit wants.
// Grid over: params set × commitment × circuitVersion × action.
// calculateWitness with sanityCheck=true; a success means that whole
// combination satisfies the circuit. The first failure line is printed
// so we can see whether different combos fail at different lines.
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

const PARAM_SETS = {
  zeros: ["0", "0", "0", "0", "0", "0", "0", "0"],
  strategy: ["20", "30", "25", "15", "10", "10", "0", "0"],
};

const SALT = "12345";

function tryInput(label, input) {
  return wc
    .calculateWitness(input, true)
    .then((witness) => {
      const pub = witness.slice(1, 10).map((x) => x.toString());
      console.log(`OK   ${label}`);
      console.log(`     public: [${pub.join(", ")}]`);
      return true;
    })
    .catch((e) => {
      const line = String(e.message || e).match(/line: (\d+)/)?.[1] ?? "?";
      console.log(`FAIL ${label} (line ${line})`);
      return false;
    });
}

for (const [pname, params] of Object.entries(PARAM_SETS)) {
  const commitments = {
    poseidon: poseidonStr(params),
    zero: "0",
  };
  for (const [cname, commitment] of Object.entries(commitments)) {
    for (const version of [0, 1, 2]) {
      for (const action of [0, 1, 2]) {
        const amount = action === 2 ? "10" : "0";
        const input = {
          matchId: hashToField("m_test_1"),
          turnNumber: "7",
          selfBalance: "100",
          opponentBalance: "80",
          action: String(action),
          amount,
          commitment: field(commitment),
          circuitVersion: String(version),
          salt: SALT,
          strategyParams: params,
        };
        await tryInput(
          `params=${pname} commitment=${cname} version=${version} action=${action} amount=${amount}`,
          input,
        );
      }
    }
  }
}
