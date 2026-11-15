# Circuit artifacts (vendored)

Downloaded 2026-11-15 from the official Agent Games site
(`https://agentgames.zkverify.io/api/circuit-info`). Both circuits are
Groth16/BN128, compiled with Circom 2.x. The binary artifacts (.wasm/.zkey)
are downloaded at Docker build time from the official site and verified
against the sha256 hashes below (see the Dockerfile); only the text
artifacts (vk.json, this README) are stored in the repo.

## Gatekeeper

| file | bytes | sha256 |
| --- | --- | --- |
| `gatekeeper.wasm` | 1,755,820 | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| `gatekeeper_final.zkey` | 309,750 | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |
| `gatekeeper_vk.json` | (exported) | vkHash `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0` |

- 13 input signals, all public (nPublic=13): `salt, registeredVkHash,
  proofVkHash, minimum, publicBalance, expiryBlock, currentBlock,
  recipient, conditionRecipient, amount, maxTransfer, decision, taskId`
  (public-signal order measured from a generated proof).
- Proof generation: ~0.6–1.8s locally; verified end-to-end (see
  `tools/test-gatekeeper.mjs`).

## Steal the VFY (vfy-policy)

| file | bytes | sha256 |
| --- | --- | --- |
| `vfy-policy.wasm` | 2,991,212 | `bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2` |
| `vfy-policy_final.zkey` | 810,586 | `f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41` |
| `vfy-policy_vk.json` | (exported) | vkHash `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047` |

- 17 input signals = 9 public + 8 private (nPublic=9). Public (assumed
  order — see README): `matchId, turnNumber, selfBalance, opponentBalance,
  action, amount, commitment, circuitVersion, salt`. Private:
  `strategyParams[0..7]`.
- STATUS 2026-11-15: the commitment/policy encoding is UNDOCUMENTED and
  could not be satisfied offline (witness generator rejects every input
  combination at `VfyPolicyProof_154 line: 72`). See README
  "Practice-mode confirmations" and `tools/probe-vfy-*.mjs` for the full
  probing record. The server attempts the proof and falls back to
  answering with the action and a null proof rather than timing out.

## Re-downloading

```sh
curl -o circuits/gatekeeper.wasm https://agentgames.zkverify.io/circuits/gatekeeper.wasm
curl -o circuits/gatekeeper_final.zkey https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
curl -o circuits/vfy-policy.wasm https://agentgames.zkverify.io/circuits/vfy-policy.wasm
curl -o circuits/vfy-policy_final.zkey https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey
# Export the verification keys:
npx snarkjs zkey export verificationkey circuits/gatekeeper_final.zkey circuits/gatekeeper_vk.json
npx snarkjs zkey export verificationkey circuits/vfy-policy_final.zkey circuits/vfy-policy_vk.json
# Then verify the sha256 hashes above match.
```
