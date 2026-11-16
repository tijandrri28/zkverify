// src/config.js — all configuration comes from environment variables.
// No secret is ever hard-coded. The server refuses to start without the
// HMAC secret: an agent that cannot verify signatures must not run.
import fs from "node:fs";
import path from "node:path";

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. See .env.example and README.md.`,
    );
  }
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  // Railway injects PORT; default 3000 for local runs.
  port: Number(optional("PORT", "3000")),
  host: optional("HOST", "0.0.0.0"),
  agentName: optional("AGENT_NAME", "caramel"),

  // HMAC secret issued at registration (Rotate Secret). 32-byte value,
  // stored as 64 hex chars (with or without a 0x prefix). NEVER commit it.
  hmacSecretHex: required("AGENT_GAMES_HMAC_SECRET"),

  // Optional: Kurier API key for submitting proofs to zkVerify on-chain.
  // When unset, proofs are returned in the response only (no Kurier call).
  kurierApiKey: optional("KURIER_API_KEY", ""),
  kurierBaseUrl: optional("KURIER_BASE_URL", "https://api.kurier.xyz/api/v1"),

  // Strategy identity for Steal the VFY.
  strategyName: optional("STRATEGY_NAME", "caramel-balanced-v1"),

  // Proof generation budget. The platform deadline is 60s; we reserve a
  // margin so we always answer instead of timing out (timeout = -2).
  proofTimeoutMs: Number(optional("PROOF_TIMEOUT_MS", "45000")),

  // Proof-reuse (PROOF_REUSED) seen-set, persisted so a restart does not
  // forget which proof_tx values were already answered.
  seenTxFile: optional(
    "SEEN_TX_FILE",
    path.join(process.cwd(), "data", "seen-proof-tx.json"),
  ),

  logLevel: optional("LOG_LEVEL", "info"),
};

export function hmacSecretBytes() {
  const hex = config.hmacSecretHex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "AGENT_GAMES_HMAC_SECRET must be 32 bytes as 64 hex chars (0x prefix optional).",
    );
  }
  // CRITICAL: the platform uses the secret STRING as the HMAC key (UTF-8
  // bytes of the 64 hex chars), NOT the hex-decoded 32 bytes. The reference
  // implementation (subastian1998/agent-games-season-01, shared/hmac.js)
  // passes the secret straight to createHmac, and hex-decoding it here made
  // every platform signature fail verification with 401.
  return Buffer.from(hex, "utf8");
}

// Fail fast at import time if the config is unusable.
hmacSecretBytes();
