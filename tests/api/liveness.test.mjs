import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginMember, loginOperator } from './helpers.mjs';
import db from '../../server/db.js';

let app;
let member;

before(async()=>{
  app=await startTestServer();
  member=await loginMember(app.base);
  assert.equal(member.response.status,200);
});
after(async()=>{await app?.close();});

async function createCase(){
  const created=await api(app.base,'/api/kyc/cases',{
    method:'POST',cookie:member.cookie,body:{countryCode:'US'}
  });
  assert.ok([200,201].includes(created.status));
  return created.data.case.id;
}

test('liveness policy never reports unvalidated controls as executable',async()=>{
  await createCase();
  const policy=await api(app.base,'/api/liveness/policy',{cookie:member.cookie});
  assert.equal(policy.status,200);
  assert.equal(policy.data.executionState,'blocked_unvalidated');
  assert.equal(policy.data.configuredControlCount,0);
  assert.equal(policy.data.requiredControlCount,17);
  assert.ok(policy.data.controls.every(item=>item.required===true));
  assert.ok(policy.data.controls.every(item=>item.configured===false));
  assert.ok(policy.data.controls.every(item=>item.executable===false));
});

test('liveness cannot start without biometric authorization',async()=>{
  const caseId=await createCase();
  const response=await api(app.base,`/api/kyc/cases/${caseId}/liveness`,{
    method:'POST',cookie:member.cookie,body:{}
  });
  assert.equal(response.status,403);
  assert.equal(response.data.noBiometricCaptureStarted,true);
  const sessions=await db.pool.query('SELECT id FROM avcu_liveness_sessions WHERE kyc_case_id=$1',[caseId]);
  assert.equal(sessions.rowCount,0);
});

test('unvalidated liveness is blocked and records every required control as not run',async()=>{
  const caseId=await createCase();
  const consent=await api(app.base,`/api/kyc/cases/${caseId}/consent`,{
    method:'POST',cookie:member.cookie,
    body:{
      noticeAcknowledged:true,locale:'en',
      consents:[{purpose:'biometric_liveness',consented:true}]
    }
  });
  assert.equal(consent.status,200);

  const response=await api(app.base,`/api/kyc/cases/${caseId}/liveness`,{
    method:'POST',cookie:member.cookie,body:{}
  });
  assert.equal(response.status,409);
  assert.equal(response.data.executionState,'blocked_unvalidated');
  assert.equal(response.data.noBiometricCaptureStarted,true);
  assert.equal(response.data.requiredControls.length,17);
  assert.ok(response.data.sessionId);

  const session=await db.pool.query(
    'SELECT status FROM avcu_liveness_sessions WHERE id=$1 AND kyc_case_id=$2',
    [response.data.sessionId,caseId]
  );
  assert.equal(session.rowCount,1);
  assert.equal(session.rows[0].status,'blocked_unvalidated');
  const checks=await db.pool.query(
    'SELECT check_key,result,details_redacted FROM avcu_liveness_check_events WHERE session_id=$1',
    [response.data.sessionId]
  );
  assert.equal(checks.rowCount,17);
  assert.ok(checks.rows.every(item=>item.result==='not_run'));
  assert.ok(checks.rows.every(item=>item.details_redacted.captureStarted===false));
});

test('declared provider coverage still cannot execute without a validated adapter',async()=>{
  const caseId=await createCase();
  const manager=await loginOperator(app.base);
  assert.equal(manager.response.status,200);
  const operator=await db.pool.query('SELECT id FROM operators WHERE email=$1',['manager@avcu.demo']);
  assert.equal(operator.rowCount,1);
  const checks=[
    'active_challenge','randomized_motion_challenge','blink_eye_movement','passive_liveness',
    'presentation_attack_detection','photo_screen_spoof_detection','deepfake_detection',
    'replay_detection','camera_injection_detection','device_integrity','session_binding',
    'face_match','document_face_consistency','document_authenticity','capture_quality','risk_fusion','manual_review'
  ];
  await db.pool.query(
    `INSERT INTO avcu_identity_sources
      (source_key,source_kind,display_name,country_codes,supported_checks,status,approval_reference,approved_by,approved_at)
     VALUES('test-liveness-source','biometric_attestation','Test liveness source',ARRAY['US']::char(2[]),$1,'approved','TEST-APPROVAL-1',$2,now())`,
    [checks,operator.rows[0].id]
  );
  await db.pool.query(
    `INSERT INTO avcu_liveness_policy_versions
      (version,country_code,enabled_checks,minimum_assurance,approved_by,approval_reference,effective_from)
     VALUES('test-policy-v1','US',$1,'high',$2,'TEST-POLICY-1',now())`,
    [checks,operator.rows[0].id]
  );

  const policy=await api(app.base,'/api/liveness/policy',{cookie:member.cookie});
  assert.equal(policy.status,200);
  assert.equal(policy.data.configuredControlCount,11);
  assert.equal(policy.data.executionState,'adapter_validation_required');
  assert.ok(policy.data.controls.every(item=>item.configured===true && item.executable===false));

  const consent=await api(app.base,`/api/kyc/cases/${caseId}/consent`,{
    method:'POST',cookie:member.cookie,
    body:{noticeAcknowledged:true,locale:'en',consents:[{purpose:'biometric_liveness',consented:true}]}
  });
  assert.equal(consent.status,200);
  const response=await api(app.base,`/api/kyc/cases/${caseId}/liveness`,{
    method:'POST',cookie:member.cookie,body:{}
  });
  assert.equal(response.status,409);
  assert.equal(response.data.executionState,'adapter_not_validated');
  assert.equal(response.data.noBiometricCaptureStarted,true);
});
