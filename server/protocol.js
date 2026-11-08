import { createPublicKey, verify as verifySignature } from "node:crypto";

export const AGENT_AUTH_DOMAIN = "pi-inbox-agent-v1";

export function agentSignaturePayload(hostId, nonce) {
  return `${AGENT_AUTH_DOMAIN}\n${hostId}\n${nonce}`;
}

export function verifyAgentSignature({ hostId, nonce, publicKey, signature }) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return verifySignature(null, Buffer.from(agentSignaturePayload(hostId, nonce)), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function requireString(value, name, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function parseMessage(raw) {
  try {
    const value = JSON.parse(raw.toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    requireString(value.type, "type", 64);
    return value;
  } catch {
    return null;
  }
}

export function sessionKey(hostId, sessionId) {
  return `${hostId}:${sessionId}`;
}
