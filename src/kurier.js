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
// ENDPOINTS — confirmed against Kurier's own docs (2026-11-16):
//   https://docs.zkverify.io/overview/getting-started/kurier
//   https://docs.zkverify.io/handbook/quickstart
//   Swagger: https://api.kurier.xyz/docs
// Base: https://api.kurier.xyz/api/v1 (NOT api.kurier.io).
// The API key goes in the URL PATH (not a Bearer header):
//   POST /register-vk/{API_KEY}      {proofType:"groth16",
//                                     proofOptions:{library:"snarkjs", curve:"bn128"},
//                                     vk}                       -> {vkHash, ...}
//   POST /submit-proof/{API_KEY}     {proofType:"groth16", vkRegistered:true,
//                                     proofOptions:{library:"snarkjs", curve:"bn128"},
//                                     proofData:{proof, publicSignals, vk: vkHash}}
//                                                          -> {jobId, optimisticVerify}
//   GET  /job-status/{API_KEY}/{jobId} -> {status: Queued|Valid|Submitted|
//                                     IncludedInBlock|Finalized|Failed, ...}
//
// SAFETY CONTRACT — Kurier must never be able to hurt a gatekeeper
// answer, so this module NEVER THROWS and NEVER BLOCKS the response:
//   * every fetch has a 30s AbortSignal timeout (measured 2026-11-16:
//     Kurier's own register-vk takes ~19s even to reject a dummy key,
//     so a 5s timeout guaranteed failure);
//   * any failure (network error, timeout, non-2xx, bad JSON) returns
//     null and is only logged — the caller keeps its original answer;
//   * submission is fire-and-forget AFTER the response is sent
//     (see submitProofFireAndForget + the server.js wiring);
//   * job-status polling is bounded (180s max) and runs in the
//     background only.
import { config } from "./config.js";

const PROOF_TYPE = "groth16";
const PROOF_OPTIONS = { library: "snarkjs", curve: "bn128" };
const FETCH_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 180000;

export function kurierEnabled() {
  return Boolean(config.kurierApiKey);
}

function log(level, msg, extra) {
  // Kurier is optional plumbing: keep its logs one line, never noisy.
  const line = { t: new Date().toISOString(), level, msg, ...(extra ?? {}) };
  console.log(JSON.stringify(line));
}

// One fetch with a hard timeout. Returns parsed JSON, or null on ANY
// failure (timeout, network error, non-2xx, unparseable body).
// Never throws.
async function kurierFetch(path, { method = "GET", body } = {}) {
  if (!kurierEnabled()) return null;
  const key = encodeURIComponent(config.kurierApiKey);
  const cleanPath = path.replace(/^\//, "").replace(/\{API_KEY\}/g, key);
  const url = `${config.kurierBaseUrl.replace(/\/+$/, "")}/${cleanPath}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    log("error", "kurier fetch failed", { path: path.split("{")[0], error: String(e.message || e) });
    return null;
  }
  if (!res.ok) {
    log("error", "kurier non-2xx", { path: path.split("{")[0], status: res.status });
    return null;
  }
  try {
    return await res.json();
  } catch (e) {
    log("error", "kurier bad JSON", { path: path.split("{")[0], error: String(e.message || e) });
    return null;
  }
}

// Register the verification key once (idempotent by vk hash).
// vk is the full verification-key JSON object (circuits/*_vk.json).
// Returns the vkHash string, or null on any failure. Never throws.
export async function registerVerificationKey(vk) {
  if (!kurierEnabled()) return null;
  const out = await kurierFetch("/register-vk/{API_KEY}", {
    method: "POST",
    body: { proofType: PROOF_TYPE, proofOptions: PROOF_OPTIONS, vk },
  });
  if (!out || typeof out.vkHash !== "string") {
    log("error", "kurier register vk: no vkHash in response");
    return null;
  }
  return out.vkHash;
}

// Submit a proof for on-chain verification.
// Returns {jobId, optimisticVerify} or null on any failure.
// Never throws.
export async function submitProof(vkHash, proof, publicSignals) {
  if (!kurierEnabled()) return null;
  const out = await kurierFetch("/submit-proof/{API_KEY}", {
    method: "POST",
    body: {
      proofType: PROOF_TYPE,
      vkRegistered: true,
      proofOptions: PROOF_OPTIONS,
      proofData: { proof, publicSignals, vk: vkHash },
    },
  });
  if (!out || typeof out.jobId !== "string") {
    log("error", "kurier submit proof: no jobId in response");
    return null;
  }
  return out;
}

// One job-status read. Returns the status object, or null on failure.
// Never throws.
export async function getJobStatus(jobId) {
  if (!kurierEnabled()) return null;
  return kurierFetch(`/job-status/{API_KEY}/${encodeURIComponent(jobId)}`);
}

// Poll job-status until Finalized/Failed or the 60s budget is spent.
// Returns the final status string ("Finalized", "Failed", ...), or
// null if the job never reached a terminal state in budget.
// Background-only; never throws.
export async function pollJobStatus(jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const st = await getJobStatus(jobId);
    const status = st?.status;
    if (status === "Finalized" || status === "Failed") return status;
    if (status) log("info", "kurier job status", { jobId, status });
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  log("error", "kurier job poll timed out", { jobId });
  return null;
}

// ---- module state: the vk hash from the one-time startup registration.
// Kept in memory only; a restart re-registers (idempotent).
let registeredVkHash = null;

export function getRegisteredVkHash() {
  return registeredVkHash;
}

// Register the vk once at startup (best-effort, background). Call it
// without awaiting: a slow or failing Kurier must never delay the
// server coming up. Retries up to 3 times: a single slow/failed
// attempt must not leave the vk unregistered for the whole process
// (an unregistered vk means no proof is ever submitted). Returns the
// vkHash or null. Never throws.
export async function ensureVkRegistered(vk) {
  if (!kurierEnabled()) return null;
  if (registeredVkHash) return registeredVkHash;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      registeredVkHash = await registerVerificationKey(vk);
    } catch (e) {
      // Defensive: registerVerificationKey never throws, but a Kurier
      // failure must not be able to crash startup through this path.
      log("error", "kurier ensureVkRegistered failed", { attempt, error: String(e.message || e) });
      registeredVkHash = null;
    }
    if (registeredVkHash) break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
  }
  if (registeredVkHash) log("info", "kurier vk registered", { vkHash: registeredVkHash });
  else log("error", "kurier vk registration failed after retries");
  return registeredVkHash;
}

// Submit a proof in the background AFTER the response has been sent.
// Fire-and-forget: the caller must NOT await this. It ensures the vk
// is registered first (retrying in the background if startup
// registration failed — an unregistered vk would otherwise silently
// skip every submission), then submits, then polls to Finalized in
// the background, and never throws or mutates anything the platform
// already received. The submit is skipped only if registration
// ultimately fails.
export async function submitProofFireAndForget(vk, proof, publicSignals) {
  try {
    if (!kurierEnabled() || !proof) return null;
    let vkHash = registeredVkHash;
    if (!vkHash) vkHash = await ensureVkRegistered(vk);
    if (!vkHash) return null;
    const out = await submitProof(vkHash, proof, publicSignals);
    if (!out) return null;
    log("info", "kurier proof submitted", { jobId: out.jobId, optimisticVerify: out.optimisticVerify });
    const finalStatus = await pollJobStatus(out.jobId);
    if (finalStatus) log("info", "kurier job finished", { jobId: out.jobId, status: finalStatus });
    return finalStatus;
  } catch (e) {
    // Never let a background Kurier error surface anywhere.
    log("error", "kurier fire-and-forget failed", { error: String(e.message || e) });
    return null;
  }
}
