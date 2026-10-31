import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator } from './helpers.mjs';

let app;
let member;
let manager;
let profileId;

before(async()=>{
  app=await startTestServer();
  member=await loginMember(app.base);
  manager=await loginOperator(app.base);
  assert.equal(member.response.status,200);
  assert.equal(manager.response.status,200);
});
after(async()=>{await app?.close();});

test('member identity profile is owner-scoped and disclosure history is visible only to that member',async()=>{
  const created=await api(app.base,'/api/identity/profile',{method:'POST',cookie:member.cookie,body:{countryCode:'US'}});
  assert.equal(created.status,201);
  profileId=created.data.profile.id;
  assert.ok(profileId);

  const managerRequest=await api(app.base,'/api/operator/identity/disclosures',{
    method:'POST',cookie:manager.cookie,body:{
      identityProfileId:profileId,
      recipientLegalEntity:'AVCU approved receiving institution',
      recipientPerson:'Named receiving officer',
      recipientRole:'Compliance officer',
      recipientIdentifier:'recipient-directory-ref-001',
      purpose:'Statutory identity confirmation for a specific compliance matter',
      legalBasis:'legal_obligation',
      authorityReference:'AUTH-TEST-001',
      channel:'secure_portal',
      fields:['legal_name','identity_verification_status'],
      expiresAt:new Date(Date.now()+86400000).toISOString(),
      reason:'Test the two-person disclosure approval control.'
    }
  });
  assert.equal(managerRequest.status,201);
  assert.equal(managerRequest.data.releaseStatus,'not_released');

  const history=await api(app.base,'/api/identity/disclosures',{cookie:member.cookie});
  assert.equal(history.status,200);
  assert.equal(history.data.disclosures.length,1);
  assert.equal(history.data.disclosures[0].status,'pending_approval');

  const selfApproval=await api(app.base,`/api/operator/identity/disclosures/${managerRequest.data.request.id}/decision`,{
    method:'POST',cookie:manager.cookie,body:{decision:'approved',reason:'Attempted self-approval should be denied.'}
  });
  assert.equal(selfApproval.status,403);
});

test('privacy notice acknowledgement is separate from optional purpose-specific consent',async()=>{
  const created=await api(app.base,'/api/kyc/cases',{method:'POST',cookie:member.cookie,body:{countryCode:'US'}});
  assert.equal(created.status,201);
  const caseId=created.data.case.id;
  const acknowledged=await api(app.base,`/api/kyc/cases/${caseId}/consent`,{
    method:'POST',cookie:member.cookie,body:{noticeAcknowledged:true,consents:[],locale:'en'}
  });
  assert.equal(acknowledged.status,200);
  assert.equal(acknowledged.data.noticeAcknowledged,true);
  assert.deepEqual(acknowledged.data.explicitConsentsRecorded,[]);
  assert.equal(acknowledged.data.providerStatus,'disabled');

  const missingNotice=await api(app.base,`/api/kyc/cases/${caseId}/consent`,{
    method:'POST',cookie:member.cookie,body:{consents:[],locale:'en'}
  });
  assert.equal(missingNotice.status,422);
});

test('identity and disclosure endpoints reject unauthenticated requests',async()=>{
  assert.equal((await api(app.base,'/api/identity/profile')).status,401);
  assert.equal((await api(app.base,'/api/operator/identity/assignments',{method:'POST',body:{}})).status,401);
  assert.equal((await api(app.base,'/api/operator/identity/disclosures',{method:'POST',body:{}})).status,401);
});
