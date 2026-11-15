// test/steal.mjs — Steal the VFY test: strategy decisions (pure logic),
// policy-proof attempt (documents the line-72 blocker), and the
// end-to-end turn handler (with its fallback).
// Run: npm run test:steal
import { decideAction, STRATEGY, strategyCommitment } from "../src/policy.js";
import { handleStealTurn } from "../src/steal.js";

console.log("== strategy decisions (caramel-balanced-v1) ==");
const cases = [
  // Opponent rich -> EXTRACT (free, non-negative expected value).
  { turn: 1, selfBalance: 100, opponentBalance: 100, want: "EXTRACT" },
  { turn: 3, selfBalance: 100, opponentBalance: 80, want: "EXTRACT" },
  { turn: 5, selfBalance: 95, opponentBalance: 20, want: "EXTRACT" },
  { turn: 4, selfBalance: 100, opponentBalance: 100, want: "EXTRACT" },
  // Opponent poor, we are rich -> FORTIFY (nothing to take, we are the target).
  { turn: 2, selfBalance: 100, opponentBalance: 5, want: "FORTIFY" },
  { turn: 6, selfBalance: 100, opponentBalance: 10, want: "FORTIFY" },
  // Both poor -> HOLD (nothing to take, nothing worth protecting).
  { turn: 2, selfBalance: 30, opponentBalance: 10, want: "HOLD" },
  { turn: 9, selfBalance: 12, opponentBalance: 8, want: "HOLD" },
  // Late game, behind: aggressive extract at the lowered threshold.
  { turn: 16, selfBalance: 60, opponentBalance: 90, want: "EXTRACT" },
  // Late game, ahead by a margin: protect the lead.
  { turn: 18, selfBalance: 120, opponentBalance: 70, want: "FORTIFY" },
];
let passed = 0;
for (const c of cases) {
  const got = decideAction(c);
  const ok = got.action === c.want;
  if (ok) passed++;
  console.log(
    `  turn=${c.turn} self=${c.selfBalance} opp=${c.opponentBalance} -> ${got.action}${got.amount !== undefined ? ` amount=${got.amount}` : ""}  (want ${c.want}) ${ok ? "OK" : "MISMATCH"}`,
  );
}
console.log(`strategy: ${passed}/${cases.length} as designed`);

console.log("== strategy commitment ==");
console.log(`  strategy: ${STRATEGY.name}`);
console.log(`  params: [${STRATEGY.params.join(", ")}]`);
console.log(`  commitment (Poseidon, ASSUMED construction): ${await strategyCommitment()}`);
console.log(`  circuitVersion: ${STRATEGY.circuitVersion}`);

console.log("== turn handler (with proof fallback) ==");
const turn = await handleStealTurn({
  type: "agent-games.steal-the-vfy.v1",
  match_id: "m_test_1",
  turn: 3,
  input: { self_balance: 100, opponent_balance: 80, commitment: await strategyCommitment() },
});
console.log(`  response: match_id=${turn.match_id} turn=${turn.turn} action=${turn.action} amount=${turn.amount ?? "(omitted)"}`);
console.log(`  idempotency_key: ${turn.idempotency_key}`);
console.log(`  proof: ${turn.proof ? "attached" : "null (proof_error: " + (turn.proof_error ?? "?").split("\n")[0] + ")"}`);
console.log(`  amount omitted for HOLD/FORTIFY: ${turn.action !== "EXTRACT" ? turn.amount === undefined : "n/a (EXTRACT carries amount)"}`);
console.log("NOTE: a null proof here is the EXPECTED local result until the");
console.log("commitment construction is confirmed via practice mode (see README).");
console.log("The handler still answers with the action instead of timing out.");
