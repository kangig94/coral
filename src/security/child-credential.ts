import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import type { Principal } from './principal.js';

/**
 * A child's long-lived credential is an Ed25519 key pair. The coordinator keeps only the public half, so a read of
 * the store that holds it cannot forge a proof; the child holds the private half and never transmits it.
 */
export type ChildCredentialKeyPair = Readonly<{
  publicKey: string;
  privateKey: string;
}>;

/** The IPC method that answers with a {@link ChildAuthChallenge}. */
export const CHILD_AUTH_CHALLENGE_METHOD = 'transport.challenge';

/** Issued on one connection and valid only for the next request on that connection. */
export type ChildAuthChallenge = Readonly<{
  challenge: string;
  incarnation: string;
  namespace: string;
}>;

/** The request a proof authenticates; `params` is exactly the value its envelope carries. */
export type ChildProvenRequest = Readonly<{ method: string; id: string | number; params: unknown }>;

export type ChildCredentialClaim = Readonly<{ credentialId: string; jobId: string; sessionId: string }>;

/**
 * An unreadable authorization record is its own answer: it denies that one credential and names it, where an
 * unknown or mismatched credential is an ordinary refusal.
 */
export type ChildPrincipalAuthentication =
  | Readonly<{ kind: 'authenticated'; principal: Principal }>
  | Readonly<{ kind: 'refused' }>
  | Readonly<{ kind: 'credential-unreadable'; credentialId: string }>;

/**
 * Everything one proof is bound to. `challenge` and `incarnation` come from the answering coordinator on the same
 * connection, so a proof cannot be replayed against another challenge, another connection, or another coordinator;
 * the request fields bind it to the one request it authenticates.
 */
export type ChildProofSubject = Readonly<{
  namespace: string;
  incarnation: string;
  challenge: string;
  credentialId: string;
  jobId: string;
  sessionId: string;
  method: string;
  requestId: string | number;
  paramsDigest: string;
}>;

const PROOF_DOMAIN = 'coral-child-proof.v1';

export function childProofSubject(
  challenge: ChildAuthChallenge,
  claim: ChildCredentialClaim,
  request: ChildProvenRequest,
): ChildProofSubject {
  return {
    namespace: challenge.namespace,
    incarnation: challenge.incarnation,
    challenge: challenge.challenge,
    credentialId: claim.credentialId,
    jobId: claim.jobId,
    sessionId: claim.sessionId,
    method: request.method,
    requestId: request.id,
    paramsDigest: digestRequestParams(request.params),
  };
}

export function mintChildCredentialKeyPair(): ChildCredentialKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  };
}

/** Both ends digest the same JSON text: the client hashes the value it encodes, the server the value it decoded. */
function digestRequestParams(params: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(params ?? null))
    .digest('base64url');
}

function proofMessage(subject: ChildProofSubject): Buffer {
  return Buffer.from(
    JSON.stringify([
      PROOF_DOMAIN,
      subject.namespace,
      subject.incarnation,
      subject.challenge,
      subject.credentialId,
      subject.jobId,
      subject.sessionId,
      subject.method,
      subject.requestId,
      subject.paramsDigest,
    ]),
  );
}

export function signChildProof(privateKey: string, subject: ChildProofSubject): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  return sign(null, proofMessage(subject), key).toString('base64url');
}

/** A key or proof that cannot be decoded verifies nothing. */
export function verifyChildProof(publicKey: string, subject: ChildProofSubject, proof: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, proofMessage(subject), key, Buffer.from(proof, 'base64url'));
  } catch {
    return false;
  }
}
