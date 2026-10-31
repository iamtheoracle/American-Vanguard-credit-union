import express from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { query, audit } from './db.js';
import { memberAuth, operatorAuth, requireOperatorRole } from './auth.js';

const router = express.Router();
const NOTICE_VERSION = process.env.AVCU_KYC_NOTICE_VERSION || '2026-10-31-v1';
const NOTICE_TEXT = process.env.AVCU_KYC_NOTICE_TEXT || 'AVCU uses an approved identity verification provider to verify identity and, where required, biometric liveness. Data may be processed outside your country. Your information is used only for identity, fraud prevention and legal compliance purposes, subject to applicable law and the published retention schedule.';
const NOTICE_HASH = createHash('sha256').update(NOTICE_TEXT).digest('hex');
const ALLOWED_COUNTRIES = new Set((process.env.AVCU_KYC_COUNTRIES || 'US').split(',').map(x => x.trim().toUpperCase()).filter(x => /^[A-Z]{2}$/.test(x)));
const PURPOSES = ['identity_verification', 'biometric_liveness', 'cross_border_processing'];

function normalizeOutcome(value) {
  const v = String(value || '').toLowerCase();
  if (['verified','passed','approved','complete','completed'].includes(v)) return 'verified';
  if (['rejected','failed','declined'].includes(v)) return 'rejected';
  if (['review_required','requires_review','needs_review','manual_review'].includes(v)) return 'review_required';
  if (['expired','cancelled','canceled'].includes(v)) return v === 'expired' ? 'expired' : 'cancelled';
  if (['pending','in_progress','processing','created'].includes(v)) return 'pending';
  return 'provider_error';
}

function truliooWebhookValid(rawBody, signature) {
  const secret = process.env.AVCU_WEBHOOK_SECRET_TRULIOO;
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function handleTruliooWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const signature = req.header('x-trulioo-signature');
  if (!truliooWebhookValid(raw, signature)) {
    await audit(null, { actorType:'system', action:'kyc.webhook.signature_rejected', entityType:'provider', entityId:'trulioo' }).catch(() => {});
    return res.status(401).json({ error:'Invalid provider signature' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error:'Invalid event payload' }); }
  const eventId = String(event.id || event.eventId || '').slice(0, 200);
  const transactionId = String(event.transactionId || event.transaction_id || '').slice(0, 200);
  if (!eventId || !transactionId) return res.status(400).json({ error:'Provider event identifiers are required' });
  const hash = createHash('sha256').update(raw).digest('hex');
  const result = await query(
    `SELECT id FROM kyc_cases WHERE provider_key='trulioo' AND provider_transaction_id=$1 LIMIT 1`,
    [transactionId]);
  const caseId = result.rows[0]?.id || null;
  try {
    await query(
      `INSERT INTO kyc_provider_events(provider_key,provider_event_id,kyc_case_id,event_type,signature_verified_at,payload_hash,sanitized_payload)
       VALUES('trulioo',$1,$2,$3,now(),$4,$5::jsonb)`,
      [eventId, caseId, String(event.event?.status || event.event?.type || 'status_update').slice(0,100), hash,
       JSON.stringify({ transactionId, event: event.event || {}, errorCode: event.error?.code || null })]);
  } catch (error) {
    if (error.code === '23505') return res.json({ received:true, replay:true });
    throw error;
  }
  if (!caseId) {
    await query(`UPDATE kyc_provider_events SET processing_status='quarantined' WHERE provider_key='trulioo' AND provider_event_id=$1`, [eventId]);
    return res.json({ received:true, quarantined:true });
  }
  const providerStatus = event.event?.status || event.event?.type || event.event?.state;
  const outcome = normalizeOutcome(providerStatus);
  await query('UPDATE kyc_cases SET status=$2,updated_at=now(),completed_at=CASE WHEN $2 IN (\'verified\',\'rejected\',\'expired\',\'cancelled\') THEN now() ELSE completed_at END WHERE id=$1',
    [caseId, outcome === 'pending' ? 'provider_pending' : outcome]);
  await query('INSERT INTO kyc_results(kyc_case_id,provider_key,outcome,reason_codes,checks_json,provider_report_ref) VALUES($1,\'trulioo\',$2,$3::jsonb,$4::jsonb,$5)',
    [caseId, outcome, JSON.stringify([]), JSON.stringify({ status: providerStatus || 'unknown' }), null]);
  await query(`UPDATE kyc_provider_events SET processing_status='processed' WHERE provider_key='trulioo' AND provider_event_id=$1`, [eventId]);
  return res.json({ received:true });
}

router.post('/kyc/cases', memberAuth, async (req,res,next) => {
  try {
    const country = String(req.body?.countryCode || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || !ALLOWED_COUNTRIES.has(country)) return res.status(422).json({ error:'KYC is not currently enabled for this country. Contact AVCU support.' });
    const existing = await query(`SELECT id,status,country_code,created_at FROM kyc_cases WHERE member_id=$1 AND status NOT IN ('verified','rejected','expired','cancelled') ORDER BY created_at DESC LIMIT 1`,[req.member.id]);
    if (existing.rowCount) return res.json({ case: existing.rows[0], noticeVersion: NOTICE_VERSION, noticeText: NOTICE_TEXT, noticeHash: NOTICE_HASH });
    const created = await query('INSERT INTO kyc_cases(member_id,country_code) VALUES($1,$2) RETURNING id,status,country_code,created_at',[req.member.id,country]);
    res.status(201).json({ case:created.rows[0], noticeVersion:NOTICE_VERSION, noticeText:NOTICE_TEXT, noticeHash:NOTICE_HASH, providerStatus:'not_configured' });
  } catch(error){next(error);}
});

router.post('/kyc/cases/:caseId/consent', memberAuth, async (req,res,next) => {
  try {
    const { caseId } = req.params;
    const owned = await query('SELECT id,status FROM kyc_cases WHERE id=$1 AND member_id=$2',[caseId,req.member.id]);
    if (!owned.rowCount) return res.status(404).json({error:'KYC case not found'});
    const consents = req.body?.consents;
    if (!Array.isArray(consents) || PURPOSES.some(p => !consents.some(c => c?.purpose===p && c?.consented===true))) {
      return res.status(422).json({error:'All required verification, biometric liveness and cross-border processing consents must be recorded before starting verification.'});
    }
    for (const purpose of PURPOSES) await query(
      `INSERT INTO kyc_consents(kyc_case_id,notice_version,purpose,consented,locale,notice_hash)
       VALUES($1,$2,$3,true,$4,$5) ON CONFLICT(kyc_case_id,purpose,notice_version) DO NOTHING`,
      [caseId,NOTICE_VERSION,purpose,String(req.body?.locale||'en').slice(0,12),NOTICE_HASH]);
    await query("UPDATE kyc_cases SET status='ready',updated_at=now() WHERE id=$1 AND status='awaiting_consent'",[caseId]);
    // Provider creation intentionally fails closed until AVCU has a configured tenant,
    // approved country/check matrix and a product-specific capture template.
    const configured = Boolean(process.env.AVCU_TRULIOO_API_TOKEN && process.env.AVCU_TRULIOO_TRANSACTION_CONFIG_JSON);
    res.json({ok:true,caseId,providerStatus:configured?'configuration_present_provider_adapter_pending':'not_configured',message:'Consent recorded. Provider transaction creation remains disabled until the selected Trulioo product configuration and country capability matrix are verified.'});
  } catch(error){next(error);}
});

router.get('/kyc/cases', memberAuth, async (req,res,next) => {
  try {
    const {rows}=await query(`SELECT c.id,c.country_code AS "countryCode",c.status,c.provider_key AS "provider",c.created_at AS "createdAt",c.updated_at AS "updatedAt",r.outcome AS "outcome"
      FROM kyc_cases c LEFT JOIN LATERAL (SELECT outcome FROM kyc_results WHERE kyc_case_id=c.id ORDER BY received_at DESC LIMIT 1) r ON true
      WHERE c.member_id=$1 ORDER BY c.created_at DESC LIMIT 20`,[req.member.id]);
    res.json({cases:rows});
  }catch(error){next(error);}
});

router.get('/operator/kyc/cases', operatorAuth, requireOperatorRole('management','super_admin','operator','auditor'), async (req,res,next)=>{
  try{
    const status=String(req.query.status||'').slice(0,40);
    const params=[]; let where='';
    if(status){params.push(status);where='WHERE c.status=$1';}
    const {rows}=await query(`SELECT c.id,c.country_code AS "countryCode",c.status,c.provider_key AS provider,c.risk_level AS "riskLevel",c.created_at AS "createdAt",m.full_name AS "memberName",m.email AS "memberEmail",c.assigned_reviewer_id AS "assignedReviewerId"
      FROM kyc_cases c JOIN members m ON m.id=c.member_id ${where} ORDER BY c.created_at DESC LIMIT 100`,params);
    await audit(null,{actorType:'operator',actorId:req.operator.id,actorRole:req.operator.role,action:'kyc.queue.viewed',entityType:'kyc',entityId:'queue'});
    res.json({cases:rows});
  }catch(error){next(error);}
});

router.get('/operator/kyc/cases/:caseId', operatorAuth, requireOperatorRole('management','super_admin','operator','auditor'), async(req,res,next)=>{
  try{
    const {rows}=await query(`SELECT c.id,c.country_code AS "countryCode",c.status,c.provider_key AS provider,c.risk_level AS "riskLevel",c.created_at AS "createdAt",c.updated_at AS "updatedAt",m.full_name AS "memberName",m.email AS "memberEmail"
      FROM kyc_cases c JOIN members m ON m.id=c.member_id WHERE c.id=$1`,[req.params.caseId]);
    if(!rows.length)return res.status(404).json({error:'KYC case not found'});
    const [consents,results,evidence,reviews]=await Promise.all([
      query('SELECT purpose,notice_version AS "noticeVersion",consented,captured_at AS "capturedAt",locale FROM kyc_consents WHERE kyc_case_id=$1 ORDER BY captured_at',[req.params.caseId]),
      query('SELECT provider_key AS provider,outcome,reason_codes AS "reasonCodes",checks_json AS checks,received_at AS "receivedAt" FROM kyc_results WHERE kyc_case_id=$1 ORDER BY received_at DESC LIMIT 20',[req.params.caseId]),
      query('SELECT id,evidence_type AS "evidenceType",provider_reference AS "providerReference",content_type AS "contentType",byte_size AS "byteSize",sha256,classification,created_at AS "createdAt",retention_expires_at AS "retentionExpiresAt",legal_hold AS "legalHold",deleted_at AS "deletedAt" FROM kyc_evidence_objects WHERE kyc_case_id=$1 ORDER BY created_at DESC',[req.params.caseId]),
      query('SELECT decision,reason_code AS "reasonCode",notes_redacted AS notes,created_at AS "createdAt" FROM kyc_reviews WHERE kyc_case_id=$1 ORDER BY created_at DESC',[req.params.caseId])
    ]);
    await query(`INSERT INTO kyc_evidence_access_events(kyc_case_id,actor_id,actor_role,action,reason,outcome) VALUES($1,$2,$3,'view_metadata',$4,'allowed')`,
      [req.params.caseId,req.operator.id,req.operator.role,String(req.query.reason||'KYC case review').slice(0,300)]);
    await audit(null,{actorType:'operator',actorId:req.operator.id,actorRole:req.operator.role,action:'kyc.case.viewed',entityType:'kyc_case',entityId:req.params.caseId});
    res.json({case:rows[0],consents:consents.rows,results:results.rows,evidence:evidence.rows,reviews:reviews.rows,evidenceMode:'metadata_only_until_private_vault_configured'});
  }catch(error){next(error);}
});

router.post('/operator/kyc/cases/:caseId/review', operatorAuth, requireOperatorRole('management','super_admin'), async(req,res,next)=>{
  try{
    const decision=String(req.body?.decision||'');
    const reasonCode=String(req.body?.reasonCode||'').trim().slice(0,80);
    const notes=String(req.body?.notes||'').trim().slice(0,2000);
    if(!['verified','rejected','review_required','request_information'].includes(decision)||reasonCode.length<2||notes.length<10)
      return res.status(422).json({error:'Select a valid review outcome and provide a reason code and meaningful notes.'});
    const current=await query('SELECT status,member_id FROM kyc_cases WHERE id=$1',[req.params.caseId]);
    if(!current.rowCount)return res.status(404).json({error:'KYC case not found'});
    if(['verified','rejected'].includes(current.rows[0].status))return res.status(409).json({error:'A completed case cannot be manually overwritten.'});
    if(decision==='verified' && current.rows[0].status!=='review_required')return res.status(409).json({error:'Manual verification is permitted only after a provider result explicitly requires human review.'});
    await query('INSERT INTO kyc_reviews(kyc_case_id,reviewer_id,decision,reason_code,notes_redacted) VALUES($1,$2,$3,$4,$5)',[req.params.caseId,req.operator.id,decision,reasonCode,notes]);
    const nextStatus=decision==='request_information'?'review_required':decision;
    await query('UPDATE kyc_cases SET status=$2,updated_at=now(),completed_at=CASE WHEN $2 IN (\'verified\',\'rejected\') THEN now() ELSE completed_at END WHERE id=$1',[req.params.caseId,nextStatus]);
    await audit(null,{actorType:'operator',actorId:req.operator.id,actorRole:req.operator.role,action:'kyc.case.reviewed',entityType:'kyc_case',entityId:req.params.caseId,metadata:{decision,reasonCode}});
    res.json({ok:true,status:nextStatus,note:'This KYC decision does not itself approve membership or activate a financial account.'});
  }catch(error){next(error);}
});

export default router;
