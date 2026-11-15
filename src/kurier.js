// src/kurier.js — OPTIONAL proof submission to zkVerify via Kurier.
//
// The platform verifies the proof from the agent's response, but the
// field guide recommends Kurier as the submission path for getting a
// proof verified on-chain (register the verification key once, submit
// proofs by vk hash, poll until Finalised). The agent's response can
// then carry the Kurier proof reference as an audit pointer.
//
// This module is ENTIRELY OPTIONAL and env-gated: it only runs when
// KURIER_API_KEY is set. Without it, proofs are returned in the
// response only, which is the path the field guide's sample response
// implies.
//
// STATUS: the exact Kurier REST endpoints are NOT yet confirmed from
// Kurier's own docs — the functions below implement the documented
// flow shape and MUST be checked against the Kurier docs before the
// key is set in production. Until then, leave KURIER_API_KEY unset.
import { config } from "./config.js";

export function kurierEnabled() {
  return Boolean(config.kurierApiKey);
}

// Register the verification key once (idempotent by vk hash).
// TODO: confirm the endpoint + payload against the Kurier docs.
export async function registerVerificationKey(vkHash, vk) {
  if (!kurierEnabled()) return null;
  const res = await fetch(`${config.kurierBaseUrl}/v1/verification-keys`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.kurierApiKey}`,
    },
    body: JSON.stringify({ vkHash, vk }),
  });
  if (!res.ok) throw new Error(`Kurier register vk failed: ${res.status}`);
  return res.json();
}

// Submit a proof for on-chain verification; returns a reference the
// platform can use to check the proof's status.
// TODO: confirm the endpoint + payload against the Kurier docs.
export async function submitProof(vkHash, proof, publicSignals) {
  if (!kurierEnabled()) return null;
  const res = await fetch(`${config.kurierBaseUrl}/v1/proofs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.kurierApiKey}`,
    },
    body: JSON.stringify({ vkHash, proof, publicSignals }),
  });
  if (!res.ok) throw new Error(`Kurier submit proof failed: ${res.status}`);
  return res.json();
}
