import express from 'express';
import { query, audit, withTx } from './db.js';
import { memberAuth } from './auth.js';

const router = express.Router();
const POLICY_VERSION = 'avcu-liveness-2026-11-v1';

// These are policy requirements, not claims that a browser or this API can perform
// the checks. A provider must explicitly attest to each capability for the country.
export const LIVENESS_CONTROLS = Object.freeze([
  { key:'active_challenge', label:'Randomized active challenge', mode:'active' },
  { key:'randomized_motion_challenge', label:'Randomized head and face movement', mode:'active' },
  { key:'blink_eye_movement', label:'Blink and eye-movement challenge', mode:'active' },
  { key:'passive_liveness', label:'Passive liveness signals', mode:'passive' },
  { key:'presentation_attack_detection', label:'Presentation-attack detection', mode:'active_and_passive' },
  { key:'photo_screen_spoof_detection', label:'Printed-photo and screen-replay spoof detection', mode:'passive' },
  { key:'deepfake_detection', label:'Deepfake and synthetic-media detection', mode:'passive' },
  { key:'replay_detection', label:'Replay and recapture detection', mode:'passive' },
  { key:'camera_injection_detection', label:'Virtual-camera and video-injection detection', mode:'passive' },
  { key:'device_integrity', label:'Device and capture-session integrity', mode:'passive' },
  { key:'session_binding', label:'Session, nonce and transaction binding', mode:'protocol' },
  { key:'face_match', label:'Selfie-to-document face comparison', mode:'biometric_match' },
  { key:'document_face_consistency', label:'Document portrait consistency', mode:'biometric_match' },
  { key:'document_authenticity', label:'Document authenticity and tamper checks', mode:'document' },
  { key:'capture_quality', label:'Capture quality and obstruction checks', mode:'passive' },
  { key:'risk_fusion', label:'Cross-signal risk assessment', mode:'policy' },
  { key:'manual_review', label:'Trained human review for uncertain or high-risk cases', mode:'human_review' }
]);

const REQUIRED_CHECKS = LIVENESS_CONTROLS.map(item => item.key);

async function capabilitySnapshot(countryCode) {
  const [sourceResult, policyResult] = await Promise.all([
    query(`SELECT id,source_key AS "sourceKey",supported_checks AS "supportedChecks",
             approval_reference AS "approvalReference",approved_by AS "approvedBy"
          FROM avcu_identity_sources
          WHERE status='approved' AND country_codes @> ARRAY[$1]::char(2[])
          ORDER BY source_key`, [countryCode]),
    query(`SELECT version,enabled_checks AS "enabledChecks",minimum_assurance AS "minimumAssurance",
             approved_by AS "approvedBy",approval_reference AS "approvalReference",
             effective_from AS "effectiveFrom"
          FROM avcu_liveness_policy_versions
          WHERE country_code=$1 AND effective_from IS NOT NULL AND effective_from<=now()
            AND approved_by IS NOT NULL AND approval_reference IS NOT NULL
          ORDER BY effective_from DESC LIMIT 1`, [countryCode])
  ]);
  const policy = policyResult.rows[0] || null;
  const source = sourceResult.rows.find(item =>
    REQUIRED_CHECKS.every(check => item.supportedChecks.includes(check))
  ) || null;
  const enabled = new Set(policy?.enabledChecks || []);
  const controls = LIVENESS_CONTROLS.map(control => ({
    ...control,
    required: true,
    configured: Boolean(source && policy && enabled.has(control.key)),
    executable: false,
    status: source && policy && enabled.has(control.key)
      ? 'component_attestation_present_adapter_not_validated'
      : 'blocked_unvalidated'
  }));
  return { policy, source, controls };
}

router.get('/liveness/policy', memberAuth, async (req,res,next) => {
  try {
    const profile = await query(
      'SELECT country_code FROM avcu_identity_profiles WHERE member_id=$1',
      [req.member.id]
    );
    if (!profile.rowCount) return res.status(404).json({ error:'Identity profile not found' });
    const snapshot = await capabilitySnapshot(profile.rows[0].country_code);
    const readyCount = snapshot.controls.filter(item => item.configured).length;
    res.json({
      policyVersion: POLICY_VERSION,
      countryCode: profile.rows[0].country_code,
      controls: snapshot.controls,
      countryPolicy: snapshot.policy,
      approvedSource: snapshot.source ? { sourceKey:snapshot.source.sourceKey } : null,
      executionState: readyCount === REQUIRED_CHECKS.length
        ? 'adapter_validation_required'
        : 'blocked_unvalidated',
      configuredControlCount: readyCount,
      requiredControlCount: REQUIRED_CHECKS.length,
      note: 'Configured means an approved country source and effective policy declare support. It does not mean the check can execute. Every check remains non-executable until its adapter and evidence path are independently validated.'
    });
  } catch(error) { next(error); }
});

router.post('/kyc/cases/:caseId/liveness', memberAuth, async (req,res,next) => {
  try {
    const owned = await query(
      `SELECT c.id,c.country_code,c.member_id,ip.id AS identity_profile_id
       FROM kyc_cases c JOIN avcu_identity_profiles ip ON ip.member_id=c.member_id
       WHERE c.id=$1 AND c.member_id=$2`, [req.params.caseId,req.member.id]
    );
    if (!owned.rowCount) return res.status(404).json({error:'KYC case not found'});
    const item = owned.rows[0];
    const consent = await query(
      `SELECT 1 FROM kyc_consents WHERE kyc_case_id=$1 AND purpose='biometric_liveness'
       AND consented=true AND withdrawn_at IS NULL LIMIT 1`, [item.id]
    );
    if (!consent.rowCount) {
      return res.status(403).json({
        error:'The required biometric-processing permission or other applicable lawful processing authorisation has not been recorded. Contact AVCU support for alternatives.',
        noBiometricCaptureStarted:true
      });
    }

    const snapshot = await capabilitySnapshot(item.country_code);
    const missing = snapshot.controls.filter(control => !control.configured).map(control => control.key);
    const session = await withTx(async client => {
      const inserted = await client.query(
        `INSERT INTO avcu_liveness_sessions
          (identity_profile_id,kyc_case_id,country_code,policy_version,status,source_id)
         VALUES($1,$2,$3,$4,'blocked_unvalidated',$5) RETURNING id`,
        [item.identity_profile_id,item.id,item.country_code,POLICY_VERSION,snapshot.source?.id || null]
      );
      const sessionId = inserted.rows[0].id;
      for (const control of LIVENESS_CONTROLS) {
        await client.query(
          `INSERT INTO avcu_liveness_check_events
            (session_id,check_key,result,source_id,method,assurance_level,reason_code,details_redacted)
           VALUES($1,$2,'not_run',$3,'not_started_no_validated_adapter','unassessed',$4,$5::jsonb)`,
          [sessionId,control.key,snapshot.source?.id || null,
            missing.includes(control.key) ? 'capability_or_policy_not_approved' : 'adapter_not_validated',
            JSON.stringify({captureStarted:false,policyVersion:POLICY_VERSION})]
        );
      }
      await audit(client,{
        actorType:'member',actorId:req.member.id,action:'identity.liveness.activation_blocked',
        entityType:'kyc_case',entityId:item.id,
        metadata:{countryCode:item.country_code,sessionId,missing,reason:'no_validated_execution_adapter'}
      });
      return sessionId;
    });

    if (missing.length) {
      return res.status(409).json({
        error:'Liveness is specified but cannot safely execute until all required country capabilities are approved.',
        executionState:'blocked_unvalidated',sessionId:session,
        requiredControls:REQUIRED_CHECKS,missing,
        noBiometricCaptureStarted:true
      });
    }
    return res.status(409).json({
      error:'The country policy and source declare coverage, but the secure challenge adapter, session binding and evidence pipeline have not passed validation.',
      executionState:'adapter_not_validated',sessionId:session,
      sourceKey:snapshot.source.sourceKey,
      requiredControls:REQUIRED_CHECKS,
      missing:['validated provider SDK/API adapter','nonce and transaction-bound session implementation','independent security and biometric privacy sign-off'],
      noBiometricCaptureStarted:true
    });
  } catch(error) { next(error); }
});

export default router;
