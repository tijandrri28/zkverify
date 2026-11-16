# zkVerify Agent Games — agent "caramel"

Node.js agent for **zkVerify Agent Games Season 01** (closes 21 Nov 2026),
entered in **both** arena tracks:

| Track | What the agent does |
| --- | --- |
| **Proof Gatekeeper** | Receives a signed payment task, decides APPROVE/REJECT against the 7 documented trap types, and returns a Groth16 proof (official circuit) that the decision is correct. 60s hard deadline, fail closed. |
| **Steal the VFY** | Plays a 20-turn match (100 VFY start) with the deterministic `caramel-balanced-v1` policy, attaching a policy proof per turn. |

Repo: <https://github.com/tijandrri28/zkverify> (public, branch `main`).
Agent name: **caramel**. No seed phrase or private key is used anywhere;
the only secret is the platform-issued HMAC secret (env var).

## Status (2026-11-15)

- **Proof Gatekeeper: WORKING end-to-end, verified locally.** Valid
  APPROVE and correct REJECT proofs generate in 0.6–1.8s and verify with
  `snarkjs groth16 verify`. The circuit refuses to prove a wrong decision
  (approving a trap, or rejecting a valid request, fails at witness
  generation) — the cryptography enforces the decision logic.
- **Steal the VFY: endpoint, strategy, and response contract implemented;
  policy proof NOT yet verifiable offline.** The vfy-policy circuit's
  commitment/policy encoding is undocumented and the witness generator
  rejects every input combination tried (see "Practice-mode
  confirmations"). The server attempts the proof and falls back to
  answering with the action and a null proof rather than timing out, so
  the agent still plays. This is the #1 item to resolve in practice mode.

## Run locally

Requires Node.js ≥ 20.

```sh
git clone https://github.com/tijandrri28/zkverify.git
cd zkverify
npm ci
cp .env.example .env
# Put the real HMAC secret in .env (from the platform's Rotate Secret).
# For a smoke test only, any 64-hex-char value works:
#   AGENT_GAMES_HMAC_SECRET=0000...0000  (64 hex chars)
npm start
# Server listens on 0.0.0.0:$PORT (default 3000).
curl http://localhost:3000/health
```

The server refuses to start without `AGENT_GAMES_HMAC_SECRET`.

## Deploy on Railway (the deployment target)

Railway hosts the agent as a long-lived Node.js server. No tunnel and no
Tailscale are needed — Railway gives the service a public HTTPS URL,
which is the URL registered with the platform.

### 1. Create the Railway project

1. Create a free Railway account (the $5 trial credit covers the
   competition window to 21 Nov; the service stops when the credit runs
   out unless a payment method is added).
2. In Railway: **New Project → Deploy from GitHub repo → select
   `tijandrri28/zkverify`** (branch `main`).
3. Railway detects the `Dockerfile` and builds the image. `railway.json`
   sets the health check (`/health`) and restart policy.

### 2. Set the environment variables

In the Railway dashboard, service → **Variables** tab, add:

| Variable | Value |
| --- | --- |
| `AGENT_GAMES_HMAC_SECRET` | The 32-byte secret from the platform's **Rotate Secret** (64 hex chars). Shown once at registration — copy it immediately and never commit it. |
| `AGENT_NAME` | `caramel` |
| `STRATEGY_NAME` | `caramel-balanced-v1` |
| `KURIER_API_KEY` | *(leave unset for now — see below)* |
| `PROOF_TIMEOUT_MS` | `45000` (optional; default 45000) |
| `LOG_LEVEL` | `info` (optional) |

`PORT` is injected by Railway automatically — do not set it.

### 3. Get the public URL and register it

1. After the deploy succeeds, Railway shows the service domain
   (Settings → Networking → Generate Domain), e.g.
   `https://zkverify-agent-caramel.up.railway.app`.
2. Check it answers: `curl https://<your-domain>/health` → `{"status":"ok",...}`.
3. In the Agent Games dashboard (**Register agent**), enter:
   - **Agent name:** `caramel`
   - **Repository URL:** `https://github.com/tijandrri28/zkverify`
   - **Agent endpoint URL:** `https://<your-domain>` (the Railway URL)
   - **Tracks:** Proof Gatekeeper + Steal the VFY
4. Complete the **signed preflight** and at least one **practice task**
   (Gatekeeper) / **practice turn** (Steal the VFY) from the dashboard.
   Practice mode is unscored and is where the open items in
   "Practice-mode confirmations" get resolved.

### 4. Redeploying

Push to `main` on GitHub; Railway redeploys automatically. The
`PROOF_REUSED` seen-set lives in `./data/seen-proof-tx.json` on the
ephemeral filesystem — it survives restarts within a deploy but not a
fresh deploy. (A persistent volume is a future hardening step; the
practical effect of losing it is that a retried task could be answered
twice instead of being caught as `PROOF_REUSED`.)

## Endpoint contract

Base URL = the Railway public URL. All POSTs require the
`x-agent-games-signature` header (HMAC-SHA256 over the **raw** body,
hex). The header is verified **before** the body is parsed; a bad or
missing signature gets `401` and no work is done. Every response is
signed the same way over the raw response body.

`GET /health` (no auth) returns
`{status:"ok", agent:"caramel", tracks:[...], strategy, kurier, time}`.

### Proof Gatekeeper — `POST /` or `POST /gatekeeper`

Incoming envelope (per the field guide):

```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_24_9d1",
  "mode": "live",
  "issued_at": "...",
  "deadline_at": "...",
  "input": {
    "registered_vk": "0x6b79...",
    "proof_vk": "0x6b79...",
    "minimum": "1000",
    "public_balance": "1460",
    "expiry_block": "19842201",
    "current_block": "19832000",
    "recipient": "0xDe42...9f01",
    "condition_recipient": "0xDe42...9f01",
    "amount": "500",
    "max_transfer": "1000",
    "proof_tx": "0xa4c1...8ff1"
  }
}
```

Decision logic (first matching trap wins; a wrong APPROVE costs −6, a
wrong REJECT −3, so on any uncertainty we REJECT):

| Check | Reject reason |
| --- | --- |
| `proof_vk != registered_vk` | `VK_SUBSTITUTION` |
| `proof_tx` already answered | `PROOF_REUSED` |
| `current_block > expiry_block` | `EXPIRED_CONDITION` |
| `public_balance < minimum` | `THRESHOLD_MISMATCH` |
| `recipient != condition_recipient` | `RECIPIENT_MISMATCH` |
| `amount > max_transfer` | `AMOUNT_OVERFLOW` |
| none of the above | `APPROVE` / `VALID_CONDITION` |

Response:

```json
{
  "decision": "APPROVE",
  "reason_code": "VALID_CONDITION",
  "proof_tx": "0xa4c1...8ff1",
  "task_id": "gk_24_9d1",
  "proof": { "pi_a": [...], "pi_b": [...], "pi_c": [...], "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["<salt>", "<registeredVkHash>", "<proofVkHash>", "1000", "1460", "19842201", "19832000", "<recipient>", "<conditionRecipient>", "500", "1000", "1", "<taskId>"]
}
```

`public_signals` order (measured from a generated proof):
`[salt, registeredVkHash, proofVkHash, minimum, publicBalance,
expiryBlock, currentBlock, recipient, conditionRecipient, amount,
maxTransfer, decision, taskId]` — all 13 inputs are public, including
the salt. Field encodings: vk hashes and addresses as integers mod the
BN128 field prime; `taskId` as `keccak256(taskId) mod p` (assumption —
confirm in practice mode). If proof generation fails, the response
still carries the decision with `"proof": null` and a `proof_error`
field (a missing proof costs −2; a timeout costs −2 too, but answering
keeps the decision scored if correct).

### Steal the VFY — `POST /` or `POST /steal-the-vfy`

Incoming envelope (field names per the guide's description; the exact
turn-envelope field names are a practice-mode confirmation — the parser
accepts `match_id`/`matchId`, `turn`/`turn_number`, `self_balance`/
`selfBalance`, `opponent_balance`/`opponentBalance`,
`commitment`/`commitment_hash`):

```json
{
  "type": "agent-games.steal-the-vfy.v1",
  "match_id": "m_...",
  "turn": 3,
  "input": {
    "self_balance": 100,
    "opponent_balance": 80,
    "commitment": "<frozen commitment hash>",
    "deadline": "..."
  }
}
```

Response:

```json
{
  "match_id": "m_...",
  "turn": 3,
  "action": "EXTRACT",
  "amount": "25",
  "idempotency_key": "caramel-m_...-turn-3",
  "strategy": "caramel-balanced-v1",
  "proof": {
    "circuitVersion": 1,
    "proof": { "pi_a": [...], "pi_b": [...], "pi_c": [...] },
    "public_signals": ["..."],
    "public_inputs_hash": "0x..."
  }
}
```

Hard rules enforced: `match_id` and `turn` are echoed exactly;
`amount` is **omitted entirely** for HOLD and FORTIFY (it is only sent
for EXTRACT); `idempotency_key` is unique per turn
(`caramel-<matchId>-turn-<turn>`). Turn deadline is 5 min; the platform
waits ~30 s per push. A timeout costs −1/turn, an invalid proof −2/turn
— so the handler always answers with the action, attaching the proof
only if it generated cleanly.

## Strategy: `caramel-balanced-v1`

A deterministic, tunable threshold policy (`src/policy.js`). The circuit
only sees `(turn, selfBalance, opponentBalance)`, so the policy is a
function of those three values. Rationale from the event page's
turn-resolution table: EXTRACT is free and has non-negative expected
value whenever the opponent holds value (it wins outright vs HOLD, is
neutral vs EXTRACT, and loses nothing vs FORTIFY), so take whenever
there is value; FORTIFY protects a lead late or when we are rich and
the opponent is poor; HOLD when both are poor.

| Rule | Action |
| --- | --- |
| Late (turn ≥ 15), behind, opponent ≥ 10 | EXTRACT up to 25 |
| Late, ahead by ≥ 15 | FORTIFY |
| Opponent balance ≥ 20 | EXTRACT up to 25 |
| Our balance ≥ 50 and opponent < 20 | FORTIFY |
| Otherwise | HOLD |

Parameters live in `STRATEGY.params` (`[20, 50, 25, 15, 10, 15, 0, 0]`)
and the commitment is `Poseidon(strategyParams)` — **the commitment
construction is an assumption** (see below). Changing the params changes
the commitment; the commitment must be registered **before Swiss Round 1**.

## Test locally

```sh
npm test            # end-to-end harness (boots the server, 17 checks)
npm run test:gatekeeper   # gatekeeper proof test (valid + 3 trap cases)
npm run test:steal        # strategy decisions + turn handler
```

Test results (2026-11-15, this VM):

- `npm test`: **17/17 passed** — health, bad-HMAC 401, gatekeeper valid
  APPROVE + proof verified offline with snarkjs, gatekeeper trap REJECT
  (`RECIPIENT_MISMATCH`) + proof verified offline, proof-reuse
  `PROOF_REUSED`, steal turn shape (EXTRACT, echoed match/turn,
  idempotency key, amount handling), unknown type 400.
- `tools/test-gatekeeper.mjs`: valid APPROVE fullProve 1.8s, verify OK,
  13 public signals; approving a trap FAILS at witness generation
  (assert, template line 102); rejecting a valid request FAILS the same
  way; correct rejects (recipient mismatch, threshold mismatch) prove in
  0.6–0.8s and verify OK.
- `test/steal.mjs`: strategy decisions **10/10 as designed**; turn
  handler answers with the action and a null proof (expected — see
  below).

## Practice-mode confirmations (must resolve before scored rounds)

These are the gaps the official docs do not pin down. Resolve them with
the dashboard's practice tasks/turns, then update the code in exactly
the places named.

1. **vfy-policy commitment construction (BLOCKER).** The witness
   generator rejects every input combination tried (100+ combos) with
   `VfyPolicyProof_154 line: 72`. Tried and failed: commitments
   `Poseidon(params)`, `Poseidon(params,salt)`, `Poseidon(salt,params)`,
   `Poseidon(params,version)`, `Poseidon(version,params)`,
   `Poseidon(params,salt,version)`, `keccak256` (3 encodings),
   `MiMCSponge`; `circuitVersion` 0, 1, 2, 154, 2026, 20261115, 100,
   1000000; actions 0–10 and `keccak256(action names)`; params zeros,
   increasing, decreasing, action-codes, all-100, all-1; `matchId`
   keccak256/0/1/42; balances 100/80, 100/100, 50/50, 200/200; salt
   0/1/12345; turns 0/1/7/20. Full record: `tools/probe-vfy-*.mjs`.
   The commitment construction and the policy semantics live in the
   strategy-commitment registration flow — use it, then set the
   construction in `src/policy.js` (`strategyCommitment`) and the action
   codes in `src/fields.js` (`ACTION`). Note the field guide's warning
   that only 9 agents were paired in Steal the VFY round 2: this is the
   barrier that kept the rest out.
2. **Gatekeeper response proof field names.** The guide's sample response
   shows `decision`/`reason_code`/`proof_tx` and says to include the
   Groth16 proof; we send `proof` (snarkjs object) + `public_signals`.
   Confirm the exact field names the platform parses in practice mode;
   they are centralised in `src/gatekeeper.js` (`handleGatekeeperTask`
   return value).
3. **`taskId` / `matchId` field encoding.** We use
   `keccak256(string) mod p`. If the platform expects a different
   encoding (e.g. the numeric suffix, or Poseidon), change `hashToField`
   in `src/fields.js`. The gatekeeper proof verifies locally either way;
   the platform's expected public signal is what must match.
4. **Steal the VFY public signal order + `publicInputsHash`.** We compute
   `keccak256` over the 9 public signals as 32-byte big-endian values in
   the assumed order `matchId, turnNumber, selfBalance, opponentBalance,
   action, amount, commitment, circuitVersion, salt`. The guide says the
   platform recomputes this hash independently and rejects on mismatch,
   and that the field order matters. Confirm both the order and the hash
   function (keccak256 vs Poseidon) in practice mode; change only
   `publicInputsHash` in `src/policy.js`.
5. **Steal the VFY turn-envelope field names.** The parser accepts the
   likely variants; confirm the real names from a practice turn and
   tighten `parseTurn` in `src/steal.js`.
6. **Strategy commitment registration.** Register the commitment (and
   `circuitVersion`) **before Swiss Round 1** or the platform cannot
   pair the agent. The commitment value is printed by
   `npm run test:steal`.
7. **Kurier.** The proof-submission path via Kurier (register vk once,
   submit proofs by vk hash, poll to Finalized) is implemented as an
   optional, env-gated module (`src/kurier.js`); its REST endpoints
   are confirmed against Kurier's own docs (api.kurier.xyz/api/v1,
   key in the URL path). Leave `KURIER_API_KEY` unset until after the
   tournament — enabling it needs a redeploy, and a restart
   mid-tournament can time out a task. Proofs are returned in the
   response meanwhile; Kurier submission is fire-and-forget after the
   response is sent and can never change an answer.

## Still needed before registration

- [ ] Push this repo to `https://github.com/tijandrri28/zkverify`
      (no token on this machine — push from a machine with access, or
      upload via the GitHub web UI).
- [ ] Railway project from the repo + env vars (above) + public domain.
- [ ] HMAC secret from the platform's Rotate Secret (shown once).
- [ ] Register the agent (name `caramel`, repo URL, Railway endpoint
      URL, both tracks) + signed preflight + practice task/turn.
- [ ] Register the Steal the VFY strategy commitment before Swiss Round 1.
- [ ] Resolve practice-mode confirmations 1–7 above.
- [ ] Kurier API key only if the on-chain submission path is wanted
      (optional; enable only after the tournament — needs a redeploy).

## Security notes

- The HMAC secret is the only credential. It lives in env vars only
  (Railway Variables / `.env`), never in the repo. The server refuses to
  start without it, and a leaked secret must be rotated from agent
  settings.
- No private key, seed phrase, or wallet is used. No transaction is ever
  signed or broadcast by this agent.
- HMAC is verified on the raw body before parsing; responses are signed
  over the raw response body. Comparisons are constant-time.
- The gatekeeper fails closed: malformed input, missing proof, or any
  uncertainty → REJECT.
