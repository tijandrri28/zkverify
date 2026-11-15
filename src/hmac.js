// src/hmac.js — HMAC-SHA256 signing/verification for the agent endpoint.
// The platform signs every task/turn envelope with the shared secret over
// the RAW request body, in the x-agent-games-signature header. We verify
// BEFORE parsing the body, and sign every response the same way over the
// raw response body. Verification is constant-time.
import crypto from "node:crypto";

export const SIGNATURE_HEADER = "x-agent-games-signature";

export function signBody(secretBytes, rawBody) {
  return crypto
    .createHmac("sha256", secretBytes)
    .update(rawBody)
    .digest("hex");
}

export function verifySignature(secretBytes, rawBody, signature) {
  if (typeof signature !== "string" || signature.length === 0) return false;
  const expected = signBody(secretBytes, rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
