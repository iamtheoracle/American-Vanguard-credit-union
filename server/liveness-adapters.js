import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const LIVENESS_RESULT_VALUES = Object.freeze(['pass','fail','inconclusive','not_run','not_applicable']);
const adapters = new Map();

export class LivenessAdapterError extends Error {
  constructor(message, code='liveness_adapter_invalid') {
    super(message);
    this.name='LivenessAdapterError';
    this.code=code;
  }
}

export function createChallengeBinding({ sessionId, caseId, countryCode, policyVersion, ttlSeconds=300 }) {
  if (!sessionId || !caseId || !/^[A-Z]{2}$/.test(countryCode || '') || !policyVersion) {
    throw new LivenessAdapterError('A complete session and country-policy binding is required.');
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds<60 || ttlSeconds>600) {
    throw new LivenessAdapterError('Challenge lifetime must be between 60 and 600 seconds.');
  }
  const nonce=randomBytes(32).toString('base64url');
  const nonceHash=createHash('sha256').update(nonce).digest('hex');
  const issuedAt=new Date();
  const expiresAt=new Date(issuedAt.getTime()+ttlSeconds*1000);
  return Object.freeze({
    sessionId,caseId,countryCode,policyVersion,nonce,nonceHash,
    issuedAt:issuedAt.toISOString(),expiresAt:expiresAt.toISOString()
  });
}

export function registerLivenessAdapter(sourceKey, adapter) {
  if (typeof sourceKey!=='string' || !/^[a-z0-9][a-z0-9._-]{2,79}$/.test(sourceKey)) {
    throw new LivenessAdapterError('Invalid adapter source key.');
  }
  const required=['health','createSession','fetchResult','verifyWebhook','verifyAttestation'];
c  = c;
  for (const method of required) {
    if (typeof adapter?.[method]!=='function') {
      throw new LivenessAdapterError(`Adapter is missing required method: ${method}`);
    }
  }
  if (typeof adapter.version!=='string' || !/^\\d+\\.\\d+\\.\\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(adapter.version)) {
    throw new LivenessAdapterError('Adapter must declare a pinned semantic version.');
  }
  if (!Array.isArray(adapter.capabilities) || adapter.capabilities.length===0 ||
      adapter.capabilities.some(key=>typeof key!=='string')) {
    throw new LivenessAdapterError('Adapter must declare explicit capabilities.');
  }
  if (adapter.mode!=='production' && adapter.mode!=='sandbox') {
    throw new LivenessAdapterError('Adapter mode must be explicitly sandbox or production.');
  }
  if (adapters.has(sourceKey)) throw new LivenessAdapterError('Adapter source key is already registered.');
  adapters.set(sourceKey,Object.freeze({...adapter,sourceKey}));
  return () => adapters.delete(sourceKey);
}

export function getLivenessAdapter(sourceKey) {
  return adapters.get(sourceKey) || null;
}

export function listLivenessAdapters() {
  return [...adapters.values()].map(adapter=>({
    sourceKey:adapter.sourceKey,version:adapter.version,mode:adapter.mode,
    capabilities:[...adapter.capabilities],
    executable:false,
    status:'adapter_contract_only_requires_provider_validation'
  }));
}

export function validateProviderAttestation(attestation, binding, requiredChecks) {
  if (!attestation || !binding || !Array.isArray(requiredChecks)) {
    throw new LivenessAdapterError('Provider attestation, session binding and required controls are mandatory.');
  }
  if (attestation.sessionId!==binding.sessionId ||
      attestation.caseId!==binding.caseId ||
      attestation.countryCode!==binding.countryCode ||
      attestation.policyVersion!==binding.policyVersion) {
    throw new LivenessAdapterError('Provider attestation is not bound to this AVCU session.', 'session_binding_failed');
  }
  const issued=Date.parse(attestation.issuedAt);
  const expires=Date.parse(attestation.expiresAt);
  const now=Date.now();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued>now+30000 || expires<=now || expires<=issued) {
    throw new LivenessAdapterError('Provider attestation is expired or has an invalid time window.', 'attestation_expired');
  }
  if (typeof attestation.nonceHash!=='string' || !/^[a-f0-9]{64}$/.test(attestation.nonceHash)) {
    throw new LivenessAdapterError('Provider attestation is missing a valid nonce binding.', 'nonce_binding_failed');
  }
  const expected=Buffer.from(binding.nonceHash,'hex');
  const supplied=Buffer.from(attestation.nonceHash,'hex');
  if (expected.length!==supplied.length || !timingSafeEqual(expected,supplied)) {
    throw new LivenessAdapterError('Provider attestation nonce does not match this AVCU session.', 'nonce_binding_failed');
  }
  if (!attestation.providerReference || typeof attestation.providerReference!=='string') {
    throw new LivenessAdapterError('Provider transaction reference is required.');
  }
  if (!attestation.signatureVerified || attestation.signatureVerified!==true) {
    throw new LivenessAdapterError('Provider signature must be verified by its adapter before normalization.', 'provider_signature_unverified');
  }
  if (!attestation.checks || typeof attestation.checks!=='object' || Array.isArray(attestation.checks)) {
    throw new LivenessAdapterError('Provider check results are missing.');
  }
  const normalized={};
  for (const key of requiredChecks) {
    const result=attestation.checks[key];
    if (!LIVENESS_RESULT_VALUES.includes(result)) {
      throw new LivenessAdapterError(`Required check has no valid normalized outcome: ${key}`);
    }
    normalized[key]=result;
  }
  const extra=Object.keys(attestation.checks).filter(key=>!requiredChecks.includes(key));
  if (extra.length) throw new LivenessAdapterError('Provider returned undeclared check keys.');
  const outcomes=Object.values(normalized);
  const decision=outcomes.includes('fail')?'failed':
    outcomes.includes('inconclusive')?'review_required':
    outcomes.includes('not_run')?'incomplete':
    outcomes.includes('not_applicable')?'review_required':'passed';
  return Object.freeze({
    providerReference:attestation.providerReference,
    decision,checks:Object.freeze(normalized),
    issuedAt:new Date(issued).toISOString(),
    expiresAt:new Date(expires).toISOString()
  });
}

export async function verifyAndNormalizeProviderAttestation(sourceKey, attestation, binding, requiredChecks) {
  const adapter=getLivenessAdapter(sourceKey);
  if (!adapter) throw new LivenessAdapterError('No approved provider adapter is registered.', 'adapter_not_installed');
  if (typeof adapter.verifyAttestation!=='function' ||
      await adapter.verifyAttestation(attestation,binding)!==true) {
    throw new LivenessAdapterError('Provider attestation signature or transaction binding could not be verified.', 'provider_signature_unverified');
  }
  return validateProviderAttestation({...attestation,signatureVerified:true},binding,requiredChecks);
}
