import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createChallengeBinding,registerLivenessAdapter,getLivenessAdapter,
  listLivenessAdapters,validateProviderAttestation,LivenessAdapterError
} from '../../server/liveness-adapters.js';

const controls=['active_challenge','passive_liveness','replay_detection'];

function adapter(){
  return {
    mode:'sandbox',capabilities:controls,
    async health(){return {status:'healthy'};},
    async createSession(){return {providerReference:'sandbox-ref'};},
    async fetchResult(){return null;},
    async verifyWebhook(){return false;}
  };
}

function attestation(binding,checks=Object.fromEntries(controls.map(key=>[key,'pass']))){
  return {
    sessionId:binding.sessionId,caseId:binding.caseId,countryCode:binding.countryCode,
    policyVersion:binding.policyVersion,nonceHash:binding.nonceHash,
    issuedAt:binding.issuedAt,expiresAt:binding.expiresAt,
    providerReference:'provider-transaction-123',signatureVerified:true,checks
  };
}

test('challenge binding creates a unique high-entropy nonce and fixed context',()=>{
  const a=createChallengeBinding({sessionId:'s1',caseId:'c1',countryCode:'US',policyVersion:'p1'});
  const b=createChallengeBinding({sessionId:'s1',caseId:'c1',countryCode:'US',policyVersion:'p1'});
  assert.equal(a.sessionId,'s1');
  assert.equal(a.nonce.length>30,true);
  assert.equal(a.nonceHash.length,64);
  assert.notEqual(a.nonceHash,b.nonceHash);
  assert.throws(()=>createChallengeBinding({sessionId:'s1',caseId:'c1',countryCode:'USA',policyVersion:'p1'}),LivenessAdapterError);
});

test('adapter registration requires an explicit contract and mode',()=>{
  const key='test-liveness-adapter';
  const unregister=registerLivenessAdapter(key,adapter());
  assert.equal(getLivenessAdapter(key).mode,'sandbox');
  assert.equal(listLivenessAdapters().find(item=>item.sourceKey===key).executable,false);
  unregister();
  assert.equal(getLivenessAdapter(key),null);
  assert.throws(()=>registerLivenessAdapter(key,{mode:'production',capabilities:[]}),LivenessAdapterError);
});

test('provider attestation must bind to the exact AVCU session and nonce',()=>{
  const binding=createChallengeBinding({sessionId:'s1',caseId:'c1',countryCode:'US',policyVersion:'p1'});
  const result=validateProviderAttestation(attestation(binding),binding,controls);
  assert.equal(result.decision,'passed');
  assert.deepEqual(result.checks,{active_challenge:'pass',passive_liveness:'pass',replay_detection:'pass'});
  const wrong={...attestation(binding),sessionId:'other'};
  assert.throws(()=>validateProviderAttestation(wrong,binding,controls),error=>error.code==='session_binding_failed');
  const wrongNonce={...attestation(binding),nonceHash:'0'.repeat(64)};
  assert.throws(()=>validateProviderAttestation(wrongNonce,binding,controls),error=>error.code==='nonce_binding_failed');
});

test('missing, unverified and adverse provider results never become a pass',()=>{
  const binding=createChallengeBinding({sessionId:'s1',caseId:'c1',countryCode:'US',policyVersion:'p1'});
  const missing=attestation(binding,{active_challenge:'pass'});
  assert.throws(()=>validateProviderAttestation(missing,binding,controls),LivenessAdapterError);
  const unsigned={...attestation(binding),signatureVerified:false};
  assert.throws(()=>validateProviderAttestation(unsigned,binding,controls),error=>error.code==='provider_signature_unverified');
  assert.equal(validateProviderAttestation(attestation(binding,{active_challenge:'pass',passive_liveness:'fail',replay_detection:'pass'}),binding,controls).decision,'failed');
  assert.equal(validateProviderAttestation(attestation(binding,{active_challenge:'pass',passive_liveness:'inconclusive',replay_detection:'pass'}),binding,controls).decision,'review_required');
  assert.equal(validateProviderAttestation(attestation(binding,{active_challenge:'pass',passive_liveness:'not_run',replay_detection:'pass'}),binding,controls).decision,'incomplete');
});
