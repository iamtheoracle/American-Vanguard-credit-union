import express from 'express';
import { query, audit } from './db.js';
import { memberAuth } from './auth.js';

const router = express.Router();
const POLICY_VERSION = 'avcu-liveness-2026-10-v1';

// All controls are part of the required policy surface. A control is not executable
// until an approved, independently validated source supports it in the member's country.
export const LIVENESS_CONTROLS = Object.freeze([
  { key:'active_challenge', label:'Randomized active challenge', mode:'active' },
  { key:'passive_liveness', label:'Passive liveness signals', mode:'passive' },
  { key:'presentation_attack_detection', label:'Presentation-attack detection', mode:'active_and_passive' },
  { key:'replay_detection', label:'Replay and recapture detection', mode:'passive' },
  { key:'camera_injection_detection', label:'Virtual-camera and injection detection', mode:'passive' },
  { key:'device_integrity', label:'Device and capture-session integrity', mode:'passive' },
  { key:'session_binding', label:'Session, nonce and transaction binding', mode:'protocol' },
  { key:'face_match', label:'Selfie-to-document face comparison', mode:'biometric_match' },
  { key:'document_face_consistency', label:'Document portrait consistency', mode:'biometric_match' },
  { key:'capture_quality', label:'Capture quality and obstruction checks', mode:'passive' },
  { key:'risk_fusion', label:'Cross-signal risk assessment', mode:'policy' }
]);

router.get('/liveness/policy', memberAuth, async (req,res,next) => {
  try {
    const result = await query(
      `SELECT country_code AS "countryCode", enabled_checks AS "enabledChecks",
        minimum_assurance AS "minimumAssurance", effective_from AS "effectiveFrom"
       FROM avcu_liveness_policy_versions
       WHERE country_code=(SELECT country_code FROM members WHERE id=$1)
         AND effective_from IS NOT NULL AND effective_from<=now()
       ORDER BY effective_from DESC LIMIT 1`, [req.member.id]);
    res.json({
      policyVersion: POLICY_VERSION,
      controls: LIVENESS_CONTROLS.map(control => ({...control, required:true, configured:true})),
      countryPolicy: result.rows[0] || null,
      executionState: result.rowCount ? 'country_policy_approved_component_checks_required' : 'configured_not_activated',
      note: 'All liveness controls are required in the AVCU design. A check cannot pass without an approved source, validated implementation and recorded evidence.'
    });
  } catch(error) { next(error); }
});

router.post('/kyc/cases/:caseId/liveness', memberAuth, async (req,res,next) => {
  try {
    const owned = await query(
      `SELECT c.id,c.country_code,c.member_id,ip.id AS identity_profile_id
       FROM kyc_cases c JOIN avcu_identity_profiles ip ON ip.member_id=c.member_id
       WHERE c.id=$1 AND c.member_id=$2`, [req.params.caseId,req.member.id]);
    if (!owned.rowCount) return res.status(404).json({error:'KYC case not found'});
    const item = owned.rows[0];
    const consent = await query(
      `SELECT 1 FROM kyc_consents WHERE kyc_case_id=$1 AND purpose='biometric_liveness'
       AND consented=true AND withdrawal_at IS NULL LIMIT 1`, [item.id]);
    if (!consent.rowCount) return res.status(403).json({error:'The required biometric-processing permission or other applicable lawful processing authorisation has not been recorded. Contact AVCU support for alternatives.'});
    const approved = await query(
      `SELECT id,source_key FROM avcu_identity_sources
       WHERE status='approved' AND country_codes @> ARRAY[$1]::char(2[])
         AND supported_checks @> ARRAY['liveness_attestation','face_match_attestation']::text[]
       ORDER BY source_key LIMIT 1`, [item.country_code]);
    if (!approved.rowCount) {
      await audit(null,{actorType:'member',actorId:req.member.id,action:'identity.liveness.activation_blocked',entityType:'kyc_case',entityId:item.id,metadata:{countryCode:item.country_code,reason:'no_approved_validated_liveness_source'}});
      return res.status(409).json({
        error:'Liveness is fully specified but cannot safely execute in this country yet.',
        executionState:'blocked_unvalidated',
        requiredControls:LIVENESS_CONTROLS.map(c=>c.key),
        missing:['independently validated liveness and presentation-attack component','approved face-match component','country-specific source approval','security and biometric privacy sign-off'],
        noBiometricCaptureStarted:true
      });
    }
    return res.status(409).json({error:'An approved source exists, but the secure challenge adapter and session binding have not been activated. No capture was started.',executionState:'adapter_not_configured',sourceKey:approved.rows[0].source_key});
  } catch(error) { next(error); }
});

export default router;
