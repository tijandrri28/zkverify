// tools/probe-vfy-hash.mjs — try more commitment hash constructions and
// a sweep of action values, all against the same baseline. If ANY
// combination passes line 72, we have the construction.
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";
import { buildPoseidon, buildMimcSponge, buildPedersenHash } from "circomlibjs";
import { ethers } from "ethers";

const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const field = (x) => (BigInt(x) % FIELD_P).toString();
const hashToField = (s) =>
  field(BigInt(ethers.keccak256(ethers.toUtf8Bytes(s))));

const poseidon = await buildPoseidon();
const poseidonStr = (inputs) =>
  poseidon.F.toString(poseidon(inputs.map((x) => BigInt(x))));
const mimc = await buildMimcSponge();
const mimcStr = (inputs) => {
  const out = mimc.multiHash(inputs.map((x) => BigInt(x)), BigInt(0));
  return mimc.F.toString(out);
};
const pedersen = await buildPedersenHash();
const pedersenStr = (inputs) => {
  // Pedersen over the concatenated 32-byte big-endian params.
  const buf = Buffer.concat(inputs.map((x) => {
    const b = Buffer.alloc(32);
    const n = BigInt(x);
    b.writeBigUInt64BE(n & 0xffffffffffffffffn, 24);
    return b;
  }));
  const out = pedersen.hash(buf);
  return pedersen.F.toString(out);
};

const wasm = fs.readFileSync("circuits/vfy-policy.wasm");
const wc = await WitnessCalculatorBuilder(wasm, { sanityCheck: true });
wc.instance.exports.init(0);

const ZEROS = ["0", "0", "0", "0", "0", "0", "0", "0"];
const SALT = "12345";

function base(overrides) {
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

// Commitment hash variants (params = zeros, action=0, version=1).
const hashVariants = {
  "mimcSponge(params)": mimcStr(ZEROS),
  "poseidon(params, version=1)": poseidonStr([...ZEROS, "1"]),
  "poseidon(version=1, params)": poseidonStr(["1", ...ZEROS]),
  "poseidon(params, salt, version)": poseidonStr([...ZEROS, SALT, "1"]),
  "keccak256(params decimal concat)": field(
    BigInt(ethers.keccak256(ethers.toUtf8Bytes(ZEROS.join("")))),
  ),
  "keccak256(params comma)": field(
    BigInt(ethers.keccak256(ethers.toUtf8Bytes(ZEROS.join(",")))),
  ),
};
for (const [label, c] of Object.entries(hashVariants)) {
  await tryInput(`commitment ${label}`, base({ commitment: field(c) }));
}

// Action sweep 0..10 with Poseidon(params) commitment, version 1.
for (let a = 0; a <= 10; a++) {
  await tryInput(
    `action=${a} (poseidon commit, version 1)`,
    base({ action: String(a), amount: a === 2 ? "10" : "0" }),
  );
}

// Action as keccak256 of the name.
for (const name of ["HOLD", "FORTIFY", "EXTRACT"]) {
  await tryInput(
    `action=keccak256("${name}")`,
    base({ action: hashToField(name), amount: "0" }),
  );
}
