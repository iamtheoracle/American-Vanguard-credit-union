import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator } from './helpers.mjs';
import db from '../../server/db.js';

let app;
let member;
let manager;
let profileId;
let kycCaseId;
let assignmentId;
let teller;

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

  const requestor=await loginOperator(app.base,'teller@avcu.demo');
  assert.equal(requestor.response.status,200);
  const operatorRow=await db.pool.query('SELECT id FROM operators WHERE email=$1',['teller@avcu.demo']);
  assert.equal(operatorRow.rowCount,1);
  const assigned=await api(app.base,'/api/operator/identity/assignments',{
    method:'POST',cookie:manager.cookie,body:{
      identityProfileId:profileId,operatorId:operatorRow.rows[0].id,
      scope:'disclosure_prepare',expiresAt:new Date(Date.now()+86400000).toISOString(),
      reason:'Assign a named requestor to prepare a specific disclosure.'
    }
  });
  assert.equal(assigned.status,201);
  const managerRequest=await api(app.base,'/api/operator/identity/disclosures',{
    method:'POST',cookie:requestor.cookie,body:{
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

  const unassignedApproval=await api(app.base,`/api/operator/identity/disclosures/${managerRequest.data.request.id}/decision`,{
    method:'POST',cookie:manager.cookie,body:{decision:'approved',reason:'Approval must require a separate assigned reviewer.'}
  });
  assert.equal(unassignedApproval.status,403);
});

test('privacy notice acknowledgement is separate from optional purpose-specific consent',async()=>{
  const created=await api(app.base,'/api/kyc/cases',{method:'POST',cookie:member.cookie,body:{countryCode:'US'}});
  assert.equal(created.status,201);
  const caseId=created.data.case.id;
  kycCaseId=caseId;
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

test('ordinary KYC operators see only actively assigned identity cases',async()=>{
  teller=await loginOperator(app.base,'teller@avcu.demo');
  assert.equal(teller.response.status,200);
  const before=await api(app.base,'/api/operator/kyc/cases',{cookie:teller.cookie});
  assert.equal(before.status,200);
  assert.equal(before.data.cases.length,0);
  const hiddenDetail=await api(app.base,`/api/operator/kyc/cases/${kycCaseId}`,{cookie:teller.cookie});
  assert.equal(hiddenDetail.status,404);

  const operatorRow=await db.pool.query('SELECT id FROM operators WHERE email=$1',['teller@avcu.demo']);
  assert.equal(operatorRow.rowCount,1);
  const assigned=await api(app.base,'/api/operator/identity/assignments',{
    method:'POST',cookie:manager.cookie,body:{
      identityProfileId:profileId,operatorId:operatorRow.rows[0].id,
      scope:'review',expiresAt:new Date(Date.now()+86400000).toISOString(),
      reason:'Assign this identity case for a controlled review.'
    }
  });
  assert.equal(assigned.status,201);
  assignmentId=assigned.data.assignment.id;

  const after=await api(app.base,'/api/operator/kyc/cases',{cookie:teller.cookie});
  assert.equal(after.status,200);
  assert.equal(after.data.cases.some(item=>item.id===kycCaseId),true);
  const visibleDetail=await api(app.base,`/api/operator/kyc/cases/${kycCaseId}`,{cookie:teller.cookie});
  assert.equal(visibleDetail.status,200);

  const revoked=await api(app.base,`/api/operator/identity/assignments/${assignmentId}/revoke',{
    method:'POST',cookie:manager.cookie,body:{}
  });
  assert.equal(revoked.status,200);
  const afterRevoke=await api(app.base,'/api/operator/kyc/cases',{cookie:teller.cookie});
  assert.equal(afterRevoke.status,200);
  assert.equal(afterRevoke.data.cases.length,0);
  const hiddenAfterRevoke=await api(app.base,`/api/operator/kyc/cases/${kycCaseId}`,{cookie:teller.cookie});
  assert.equal(hiddenAfterRevoke.status,404);
});
