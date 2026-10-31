import express from 'express';
import { query, audit, withTx } from './db.js';
import { memberAuth, operatorAuth, requireOperatorRole } from './auth.js';

const router = express.Router();
const FIELD_ALLOWLIST = new Set([
  'legal_name','date_of_birth','residential_address','nationality','government_id_type',
  'government_id_number','document_image','selfie_image','liveness_result',
  'identity_verification_status','verification_reference','contact_email','contact_phone'
]);
const CATEGORY = {
  legal_name:'identity', date_of_birth:'identity', residential_address:'address',
  nationality:'identity', government_id_type:'identity_document',
  government_id_number:'identity_document', document_image:'identity_document',
  selfie_image:'biometric', liveness_result:'biometric_attestation',
  identity_verification_status:'verification', verification_reference:'verification',
  contact_email:'contact', contact_phone:'contact'
};

async function profileForMember(memberId) {
  const result = await query('SELECT id,country_code,lifecycle_status FROM avcu_identity_profiles WHERE member_id=$1',[memberId]);
  return result.rows[0] || null;
}
async function canAccessProfile(operator, profileId, scope='review') {
  if (!['operator','management','super_admin'].includes(operator.role)) return false;
  const result = await query(
    `SELECT 1 FROM avcu_identity_case_assignments
     WHERE identity_profile_id=$1 AND operator_id=$2 AND scope=ANY($3::text[])
       AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) LIMIT 1`,
    [profileId,operator.id,scope==='review'?['review','evidence_metadata']:[scope]]);
  return result.rowCount>0;
}

router.get('/identity/profile', memberAuth, async(req,res,next)=>{
  try { res.json({profile:await profileForMember(req.member.id)}); } catch(error){next(error);}
});

router.post('/identity/profile', memberAuth, async(req,res,next)=>{
  try {
    const country=String(req.body?.countryCode||'').toUpperCase();
    const enabled=new Set((process.env.AVCU_KYC_COUNTRIES||'US').split(',').map(v=>v.trim().toUpperCase()));
    if(!/^[A-Z]{2}$/.test(country)||!enabled.has(country)) return res.status(422).json({error:'Identity services are not enabled for this country.'});
    const result=await query(
      `INSERT INTO avcu_identity_profiles(member_id,country_code)
       VALUES($1,$2) ON CONFLICT(member_id) DO UPDATE SET updated_at=now()
       RETURNING id,country_code,lifecycle_status`,[req.member.id,country]);
    await audit(null,{actorType:'member',actorId:req.member.id,action:'identity.profile.created_or_reused',entityType:'identity_profile',entityId:result.rows[0].id});
    res.status(201).json({profile:result.rows[0]});
  } catch(error){next(error);}
});


router.post('/operator/identity/assignments',operatorAuth,requireOperatorRole('management','super_admin'),async(req,res,next)=>{
  try{
    const profileId=String(req.body?.identityProfileId||'');
    const operatorId=String(req.body?.operatorId||'');
    const scope=String(req.body?.scope||'');
    const reason=String(req.body?.reason||'').trim().slice(0,500);
    const expiresAt=req.body?.expiresAt?new Date(req.body.expiresAt):null;
    if(!profileId||!operatorId||!['review','evidence_metadata','disclosure_prepare'].includes(scope)||reason.length<10||
      (expiresAt&&Number.isNaN(expiresAt.getTime()))||(expiresAt&&expiresAt<=new Date())||
      (expiresAt&&expiresAt>new Date(Date.now()+30*86400000)))return res.status(422).json({error:'Provide a valid case, operator, narrowly scoped permission, reason and optional expiry within 30 days.'});
    if(operatorId===String(req.operator.id))return res.status(422).json({error:'A manager cannot grant a case assignment to themselves.'});
    const result=await query(
      `INSERT INTO avcu_identity_case_assignments(identity_profile_id,operator_id,assigned_by,scope,expires_at,reason)
       SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM avcu_identity_profiles WHERE id=$1)
       RETURNING id,identity_profile_id AS "identityProfileId",operator_id AS "operatorId",scope,assigned_at AS "assignedAt",expires_at AS "expiresAt"`,
      [profileId,operatorId,req.operator.id,scope,expiresAt?.toISOString()||null,reason]);
    if(!result.rowCount)return res.status(404).json({error:'Identity profile not found'});
    await audit(null,{actorType:'operator',actorId:req.operator.id,actorRole:req.operator.role,action:'identity.case.assigned',entityType:'identity_profile',entityId:profileId,metadata:{operatorId,scope,expiresAt:expiresAt?.toISOString()||null}});
    res.status(201).json({assignment:result.rows[0]});
  }catch(error){next(error);}
});

router.post('/operator/identity/assignments/:assignmentId/revoke',operatorAuth,requireOperatorRole('management','super_admin'),async(req,res,next)=>{
  try{
    const result=await query(
      `UPDATE avcu_identity_case_assignments SET revoked_at=now()
       WHERE id=$1 AND revoked_at IS NULL RETURNING id,identity_profile_id AS "identityProfileId",operator_id AS "operatorId",scope,revoked_at AS "revokedAt"`,
      [req.params.assignmentId]);
    if(!result.rowCount)return res.status(404).json({error:'Active assignment not found'});
    await audit(null,{actorType:'operator',actorId:req.operator.id,actorRole:req.operator.role,action:'identity.case.assignment_revoked',entityType:'identity_assignment',entityId:req.params.assignmentId});
    res.json({assignment:result.rows[0]});
  }catch(error){next(error);}
});

router.get('/identity/disclosures', memberAuth, async(req,res,next)=>{
  try {
    const profile=await profileForMember(req.member.id);
    if(!profile)return res.json({disclosures:[]});
    const result=await query(
      `SELECT d.id,d.recipient_legal_entity AS "recipientLegalEntity",d.recipient_person AS "recipientPerson",
       d.recipient_role AS "recipientRole",d.recipient_identifier AS "recipientIdentifier",d.purpose,
       d.legal_basis AS "legalBasis",d.authority_reference AS "authorityReference",d.channel,d.status,
       d.created_at AS "createdAt",d.approved_at AS "approvedAt",d.released_at AS "releasedAt",d.expires_at AS "expiresAt",
       requester.name AS "requestedBy",approver.name AS "approvedBy",
       COALESCE((SELECT json_agg(json_build_object('field',f.field_key,'category',f.data_category) ORDER BY f.field_key)
         FROM avcu_data_disclosure_fields f WHERE f.disclosure_request_id=d.id),'[]'::json) AS fields,
       COALESCE((SELECT json_agg(json_build_object('event',e.event_type,'actorType',e.actor_type,'actorId',e.actor_id,'reason',e.reason,'occurredAt',e.occurred_at) ORDER BY e.occurred_at)
         FROM avcu_data_disclosure_events e WHERE e.disclosure_request_id=d.id),'[]'::json) AS events
       FROM avcu_data_disclosure_requests d
       LEFT JOIN operators requester ON requester.id=d.requested_by
       LEFT JOIN operators approver ON approver.id=d.approved_by
       WHERE d.identity_profile_id=$1 ORDER BY d.created_at DESC LIMIT 100`,
      [profile.id]);
    res.json({disclosures:result.rows});
  }catch(error){next(error);}
});

router.post('/operator/identity/disclosures',operatorAuth,requireOperatorRole('management','super_admin','operator'),async(req,res,next)=>{
  try {
    const b=req.body||{};
    const profileId=String(b.identityProfileId||'');
    const recipientLegalEntity=String(b.recipientLegalEntity||'').trim().slice(0,240);
    const recipientPerson=String(b.recipientPerson||'').trim().slice(0,200);
    const recipientRole=String(b.recipientRole||'').trim().slice(0,160);
    const recipientIdentifier=String(b.recipientIdentifier||'').trim().slice(0,240);
    const purpose=String(b.purpose||'').trim().slice(0,1000);
    const legalBasis=String(b.legalBasis||'');
    const authorityReference=String(b.authorityReference||'').trim().slice(0,300)||null;
    const channel=String(b.channel||'');
    const reason=String(b.reason||'').trim().slice(0,500);
    const fields=Array.isArray(b.fields)?[...new Set(b.fields.map(v=>String(v)))]:[];
    const expiresAt=new Date(b.expiresAt);
    if(!profileId||!recipientLegalEntity||!recipientPerson||!recipientRole||!recipientIdentifier||purpose.length<10||reason.length<10||
      !['legal_obligation','contract','legitimate_interests','consent','vital_interests','public_task','other_approved_basis'].includes(legalBasis)||
      !['secure_api','secure_portal','encrypted_transfer','regulated_network','other_approved_channel'].includes(channel)||
      !fields.length||fields.some(f=>!FIELD_ALLOWLIST.has(f))||Number.isNaN(expiresAt.getTime())||expiresAt<=new Date()||expiresAt>new Date(Date.now()+90*86400000)) {
      return res.status(422).json({error:'Disclosure request is incomplete or contains an unsupported field, purpose, basis, channel or expiry.'});
    }
    const profile=await query('SELECT id FROM avcu_identity_profiles WHERE id=$1',[profileId]);
    if(!profile.rowCount)return res.status(404).json({error:'Identity profile not found'});
    if(!await canAccessProfile(req.operator,profileId,'disclosure_prepare'))return res.status(403).json({error:'This identity case is not assigned to you.'});
    if(legalBasis==='other_approved_basis'&&!authorityReference)return res.status(422).json({error:'An authority reference is required for this legal basis.'});
    const created=await withTx(async client=>{
      const request=await client.query(
        `INSERT INTO avcu_data_disclosure_requests
         (identity_profile_id,recipient_legal_entity,recipient_person,recipient_role,recipient_identifier,purpose,legal_basis,authority_reference,channel,requested_by,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,status,created_at`,
        [profileId,recipientLegalEntity,recipientPerson,recipientRole,recipientIdentifier,purpose,legalBasis,authorityReference,channel,req.operator.id,expiresAt.toISOString()]);
      for(const field of fields) await client.query(
        'INSERT INTO avcu_data_disclosure_fields(disclosure_request_id,field_key,data_category) VALUES($1,$2,$3)',
        [request.rows[0].id,field,CATEGORY[field]]);
      await client.query(
        `INSERT INTO avcu_data_disclosure_events(disclosure_request_id,event_type,actor_type,actor_id,reason,channel,recipient_snapshot,fields_snapshot,authority_snapshot)
         VALUES($1,'requested','operator',$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
        [request.rows[0].id,String(req.operator.id),reason,channel,
         JSON.stringify({legalEntity:recipientLegalEntity,person:recipientPerson,role:recipientRole,identifier:recipientIdentifier}),
         JSON.stringify(fields),JSON.stringify({legalBasis,authorityReference,purpose,expiresAt:expiresAt.toISOString()})]);
      await audit(client,{actorType:'operator',actorId:req.operator.id,actorRole:req.operator.role,action:'identity.disclosure.requested',entityType:'disclosure_request',entityId:request.rows[0].id,metadata:{fieldCount:fields.length,legalBasis,channel}});
      return request;
    });
    res.status(201).json({request:created.rows[0],releaseStatus:'not_released',message:'A separate authorised reviewer must approve this request. No information has been disclosed.'});
  }catch(error){next(error);}
});

router.post('/operator/identity/disclosures/:requestId/decision',operatorAuth,requireOperatorRole('management','super_admin'),async(req,res,next)=>{
  try{
    const decision=String(req.body?.decision||'');
    const reason=String(req.body?.reason||'').trim().slice(0,500);
    if(!['approved','denied'].includes(decision)||reason.length<10)return res.status(422).json({error:'Provide an approval or denial and a meaningful reason.'});
    const result=await withTx(async client=>{
      const current=await client.query('SELECT id,identity_profile_id,requested_by,status,expires_at FROM avcu_data_disclosure_requests WHERE id=$1 FOR UPDATE',[req.params.requestId]);
      if(!current.rowCount)return {error:'not_found'};
      const item=current.rows[0];
      if(String(item.requested_by)===String(req.operator.id))return {error:'self_approval'};
      if(item.status!=='pending_approval'||new Date(item.expires_at)<=new Date())return {error:'not_pending'};
      const assigned=await client.query(
        `SELECT 1 FROM avcu_identity_case_assignments WHERE identity_profile_id=$1 AND operator_id=$2
         AND scope IN ('review','evidence_metadata') AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at>now()) LIMIT 1`,[item.identity_profile_id,req.operator.id]);
      if(!assigned.rowCount)return {error:'not_assigned'};
      const changed=await client.query(
        `UPDATE avcu_data_disclosure_requests SET status=$2,approved_by=$3,approved_at=now()
         WHERE id=$1 AND status='pending_approval' RETURNING id,status,approved_at`,
        [item.id,decision,req.operator.id]);
      if(!changed.rowCount)return {error:'not_pending'};
      const fields=await client.query('SELECT field_key,data_category FROM avcu_data_disclosure_fields WHERE disclosure_request_id=$1 ORDER BY field_key',[item.id]);
      await client.query(
        `INSERT INTO avcu_data_disclosure_events(disclosure_request_id,event_type,actor_type,actor_id,reason,fields_snapshot,authority_snapshot)
         VALUES($1,$2,'operator',$3,$4,$5::jsonb,$6::jsonb)`,
        [item.id,decision,String(req.operator.id),reason,JSON.stringify(fields.rows),JSON.stringify({approvedBy:req.operator.id,decision})]);
      await audit(client,{actorType:'operator',actorId:req.operator.id,actorRole:req.operator.role,action:'identity.disclosure.'+decision,entityType:'disclosure_request',entityId:item.id,metadata:{requester:item.requested_by}});
      return {request:changed.rows[0]};
    });
    if(result.error==='not_found')return res.status(404).json({error:'Disclosure request not found'});
    if(result.error==='self_approval')return res.status(403).json({error:'The requester cannot approve their own disclosure.'});
    if(result.error==='not_assigned')return res.status(403).json({error:'A separate reviewer must be assigned to this identity case.'});
    if(result.error==='not_pending')return res.status(409).json({error:'This disclosure request is no longer pending or has expired.'});
    res.json({request:result.request,releaseStatus:'not_released',message:'Approval records permission only. Data transfer remains disabled until the secure vault, recipient authentication and release receipt controls are implemented and tested.'});
  }catch(error){next(error);}
});

export default router;
