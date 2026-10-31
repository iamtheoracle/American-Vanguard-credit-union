import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { query, withTx } from './db.js';

const TEAM_CAPABILITIES = Object.freeze({
 'member-experience':['member.read','member.support'],
 'identity-trust':['identity.verify','risk.signal'],
 'payments-ledger':['ledger.read','payment.propose'],
 'cards-lending':['cards.request','loans.apply'],
 'communications':['notifications.send'],
 'travel':['travel.search'],
 'ai-orchestration':['ai.respond'],
 'risk-compliance':['policy.evaluate','audit.read'],
 'operations':['runtime.monitor','runtime.control']
});
const JOB_POLICY = Object.freeze({
 'notification.deliver':{team:'communications',capability:'notifications.send'},
 'travel.search':{team:'travel',capability:'travel.search'},
 'ai.respond':{team:'ai-orchestration',capability:'ai.respond'},
 'risk.evaluate':{team:'risk-compliance',capability:'policy.evaluate'},
 'member.task':{team:'member-experience',capability:'member.support'}
});
const MAX_PAYLOAD_BYTES = 256 * 1024;

export function serviceTokenEnvName(serviceId) {
  return 'AVCU_SERVICE_TOKEN_' + String(serviceId).toUpperCase().replace(/[^A-Z0-9]/g,'_');
}
export function serviceSecret(serviceId) {
  const value = process.env[serviceTokenEnvName(serviceId)];
  if (!value || value.length < 32) return null;
  return value;
}
export function verifyServiceIdentity(serviceId, presentedToken) {
  const expected=serviceSecret(serviceId);
  if (!expected || typeof presentedToken!=='string') return false;
  const a=Buffer.from(createHash('sha256').update(expected).digest());
  const b=Buffer.from(createHash('sha256').update(presentedToken).digest());
  return a.length===b.length && timingSafeEqual(a,b);
}
export function providerSecret(provider, key) {
  const name='AVCU_PROVIDER_'+String(provider).toUpperCase().replace(/[^A-Z0-9]/g,'_')+'_'+String(key).toUpperCase().replace(/[^A-Z0-9]/g,'_');
  const value=process.env[name];
  return typeof value==='string' && value.length ? value : null;
}
export function providerAdapter(provider, {baseUrl,allowedHosts,tokenEnv,timeoutMs=8000}={}) {
  const url=new URL(baseUrl);
  if(url.protocol!=='https:' || !Array.isArray(allowedHosts) || !allowedHosts.includes(url.hostname)) throw new Error('Provider URL must use HTTPS and an explicitly allowed hostname.');
  return Object.freeze({
    name:provider,
    async request(path,{method='GET',body,idempotencyKey}={}) {
      if(typeof path!=='string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('Provider path must be an absolute path on the configured host.');
      const target=new URL(path,url);
      if(target.origin!==url.origin) throw new Error('Provider request escaped its configured origin.');
      const token=process.env[tokenEnv];
      if(!token) { const e=new Error('Provider credential is not configured.'); e.code='provider_not_configured'; throw e; }
      const response=await fetch(target,{method,headers:{Authorization:'Bearer '+token,'Accept':'application/json','Content-Type':'application/json',...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
      const data=await response.json().catch(()=>null);
      if(!response.ok){const e=new Error('Provider request failed with HTTP '+response.status);e.code='provider_http_'+response.status;e.retryable=response.status===408||response.status===429||response.status>=500;throw e;}
      return data;
    }
  });
}


export async function registerServiceIdentity({teamId,serviceId,capabilities}) {
 const token=serviceSecret(serviceId);
 if(!token) return {registered:false,reason:'credential_not_configured'};
 const allowed=TEAM_CAPABILITIES[teamId]||[];
 if(!Array.isArray(capabilities)||capabilities.some(c=>!allowed.includes(c))) throw new Error('Service identity requests capabilities outside its team boundary.');
 const hash=createHash('sha256').update(token).digest('hex');
 await query(
  `INSERT INTO avcu_service_identities(service_id,team_id,token_sha256,capabilities,active,rotated_at)
   VALUES($1,$2,$3,$4::jsonb,true,now())
   ON CONFLICT(service_id) DO UPDATE SET team_id=EXCLUDED.team_id,token_sha256=EXCLUDED.token_sha256,capabilities=EXCLUDED.capabilities,active=true,rotated_at=now()`,
  [serviceId,teamId,hash,JSON.stringify(capabilities)]);
 return {registered:true,serviceId,teamId};
}
export async function validateWorkerIdentity({teamId,serviceId,token}) {
 const {rows}=await query('SELECT team_id,token_sha256,capabilities,active FROM avcu_service_identities WHERE service_id=$1',[serviceId]);
 const row=rows[0];
 if(!row||!row.active||row.team_id!==teamId||!verifyServiceIdentity(serviceId,token)) return false;
 const hash=createHash('sha256').update(token).digest('hex');
 const a=Buffer.from(row.token_sha256,'hex'),b=Buffer.from(hash,'hex');
 return a.length===b.length&&timingSafeEqual(a,b);
}
\nexport async function enqueueJob({teamId,serviceId,jobType,payload,idempotencyKey,maxAttempts=8,delaySeconds=0}) {
  const policy=JOB_POLICY[jobType];
  if(!TEAM_CAPABILITIES[teamId] || !policy || policy.team!==teamId) throw new Error('Job type is not permitted for this team.');
  const serialized=JSON.stringify(payload ?? {});
  if(Buffer.byteLength(serialized)>MAX_PAYLOAD_BYTES) throw new Error('Job payload exceeds limit.');
  if(typeof idempotencyKey!=='string'||idempotencyKey.length<8||idempotencyKey.length>200) throw new Error('A stable idempotency key is required.');
  const result=await query(
   `INSERT INTO avcu_jobs(team_id,service_id,job_type,payload,idempotency_key,max_attempts,available_at)
    SELECT $1,$2,$3,$4::jsonb,$5,$6,now()+($7*interval '1 second')
    WHERE EXISTS(SELECT 1 FROM avcu_service_identities s WHERE s.service_id=$2 AND s.team_id=$1 AND s.active)
      AND EXISTS(SELECT 1 FROM avcu_team_runtime t WHERE t.team_id=$1 AND t.desired_state='ACTIVE')\n      AND EXISTS(SELECT 1 FROM avcu_service_identities s WHERE s.service_id=$2 AND s.team_id=$1 AND s.active AND s.capabilities ? $8)
    ON CONFLICT(team_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
    RETURNING id,team_id,status,attempts,created_at`,
   [teamId,serviceId,jobType,serialized,idempotencyKey,maxAttempts,delaySeconds,policy.capability]);
  if(!result.rowCount) throw new Error('Service identity inactive or team not enabled.');
  return result.rows[0];
}

export async function claimJob({teamId,workerId,leaseSeconds=60}) {
 return withTx(async client=>{
  const expired=await client.query(
   `UPDATE avcu_jobs SET status=CASE WHEN attempts>=max_attempts THEN 'dead_letter' ELSE 'retry_wait' END,
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,available_at=now()+interval '5 seconds',updated_at=now(),
    last_error_code='worker_lease_expired'
    WHERE team_id=$1 AND status='leased' AND lease_expires_at<now()
    RETURNING id,team_id,job_type,attempts,status`,[teamId]);
  for(const job of expired.rows) {
   await client.query(`INSERT INTO avcu_job_events(job_id,event_type,attempt,detail) VALUES($1,'job.lease_expired',$2,'{"recovered":true}'::jsonb)`,[job.id,job.attempts]);
   if(job.status==='dead_letter') await client.query(
    `INSERT INTO avcu_job_dead_letters(job_id,team_id,job_type,final_error_code,attempts) VALUES($1,$2,$3,'worker_lease_expired',$4) ON CONFLICT(job_id) DO NOTHING`,
    [job.id,job.team_id,job.job_type,job.attempts]);
  }
  const {rows}=await client.query(
   `SELECT j.* FROM avcu_jobs j JOIN avcu_team_runtime t ON t.team_id=j.team_id
    WHERE j.team_id=$1 AND j.status IN ('queued','retry_wait') AND j.available_at<=now()
      AND t.desired_state='ACTIVE' AND t.lifecycle_state IN ('ACTIVE','DEGRADED')
    ORDER BY j.available_at,j.created_at LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[teamId]);
  if(!rows[0]) return null;
  const row=rows[0],token=randomUUID();
  const updated=await client.query(
   `UPDATE avcu_jobs SET status='leased',attempts=attempts+1,lease_owner=$2,lease_token=$3,
    lease_expires_at=now()+($4*interval '1 second'),updated_at=now()
    WHERE id=$1 RETURNING *`,[row.id,workerId,token,leaseSeconds]);
  await client.query(`INSERT INTO avcu_job_events(job_id,event_type,worker_id,attempt) VALUES($1,'job.leased',$2,$3)`,[row.id,workerId,updated.rows[0].attempts]);
  return updated.rows[0];
 });
}
export async function renewJobLease({jobId,leaseToken,workerId,leaseSeconds=60}) {
 const result=await query(
  `UPDATE avcu_jobs SET lease_expires_at=now()+($4*interval '1 second'),updated_at=now()
   WHERE id=$1 AND status='leased' AND lease_token=$2 AND lease_owner=$3 RETURNING id`,
  [jobId,leaseToken,workerId,leaseSeconds]);
 return result.rowCount===1;
}
export async function acknowledgeJob({jobId,leaseToken,workerId,result}) {
 return withTx(async client=>{
  const row=await client.query(`SELECT * FROM avcu_jobs WHERE id=$1 AND status='leased' AND lease_token=$2 AND lease_owner=$3 FOR UPDATE`,[jobId,leaseToken,workerId]);
  if(!row.rows[0]) {const e=new Error('Lease is stale or does not belong to this worker.');e.status=409;throw e;}
  const updated=await client.query(`UPDATE avcu_jobs SET status='succeeded',result=$2::jsonb,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE id=$1 RETURNING id,status,attempts`,[jobId,JSON.stringify(result??{})]);
  await client.query(`INSERT INTO avcu_job_events(job_id,event_type,worker_id,attempt) VALUES($1,'job.acknowledged',$2,$3)`,[jobId,workerId,row.rows[0].attempts]);
  return updated.rows[0];
 });
}
export async function failJob({jobId,leaseToken,workerId,errorCode,retryable=true}) {
 return withTx(async client=>{
  const row=await client.query(`SELECT * FROM avcu_jobs WHERE id=$1 AND status='leased' AND lease_token=$2 AND lease_owner=$3 FOR UPDATE`,[jobId,leaseToken,workerId]);
  if(!row.rows[0]) {const e=new Error('Lease is stale or does not belong to this worker.');e.status=409;throw e;}
  const j=row.rows[0],dead=!retryable||j.attempts>=j.max_attempts;
  const delay=Math.min(3600,Math.pow(2,Math.max(0,j.attempts-1))*5);
  await client.query(`UPDATE avcu_jobs SET status=$2,available_at=now()+($3*interval '1 second'),last_error_code=$4,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`,[jobId,dead?'dead_letter':'retry_wait',delay,String(errorCode||'worker_error').slice(0,100)]);
  await client.query(`INSERT INTO avcu_job_events(job_id,event_type,worker_id,attempt,detail) VALUES($1,$2,$3,$4,$5::jsonb)`,[jobId,dead?'job.dead_lettered':'job.retry_scheduled',workerId,j.attempts,JSON.stringify({errorCode,retryable,delaySeconds:dead?0:delay})]);
  if(dead) await client.query(`INSERT INTO avcu_job_dead_letters(job_id,team_id,job_type,final_error_code,attempts) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id) DO NOTHING`,[jobId,j.team_id,j.job_type,errorCode,j.attempts]);
  return {id:jobId,status:dead?'dead_letter':'retry_wait',attempts:j.attempts,nextDelaySeconds:dead?0:delay};
 });
}
export async function heartbeat({workerId,teamId,serviceId,status,activeJobId=null}) {
 await query(`INSERT INTO avcu_worker_heartbeats(worker_id,team_id,service_id,status,active_job_id,last_seen_at)
 VALUES($1,$2,$3,$4,$5,now()) ON CONFLICT(worker_id) DO UPDATE SET status=EXCLUDED.status,active_job_id=EXCLUDED.active_job_id,last_seen_at=now()`,[workerId,teamId,serviceId,status,activeJobId]);
 await query(`UPDATE avcu_team_runtime SET lifecycle_state=CASE
   WHEN desired_state='ACTIVE' AND $2 IN ('healthy','degraded') THEN CASE WHEN $2='healthy' THEN 'ACTIVE' ELSE 'DEGRADED' END
   WHEN desired_state='PAUSED' THEN 'PAUSED'
   WHEN desired_state='DRAINING' THEN 'DRAINING'
   WHEN desired_state='QUARANTINED' THEN 'QUARANTINED'
   WHEN desired_state='DISABLED' THEN 'DISABLED'
   ELSE lifecycle_state END,
   last_heartbeat_at=now(),health=jsonb_build_object('workerId',$3,'status',$2,'activeJobId',$4),updated_at=now()
   WHERE team_id=$1`,[teamId,status,workerId,activeJobId]);
}
\nexport async function teamQueueHealth() {
 const result=await query(
  `SELECT t.team_id,t.lifecycle_state,t.desired_state,t.last_heartbeat_at,
    count(j.id) FILTER (WHERE j.status IN ('queued','retry_wait'))::int AS queued,
    count(j.id) FILTER (WHERE j.status='leased')::int AS leased,
    count(j.id) FILTER (WHERE j.status='dead_letter')::int AS dead_letter,
    count(w.worker_id) FILTER (WHERE w.last_seen_at>now()-interval '90 seconds')::int AS live_workers
   FROM avcu_team_runtime t
   LEFT JOIN avcu_jobs j ON j.team_id=t.team_id
   LEFT JOIN avcu_worker_heartbeats w ON w.team_id=t.team_id
   GROUP BY t.team_id,t.lifecycle_state,t.desired_state,t.last_heartbeat_at
   ORDER BY t.team_id`);
 return result.rows;
}
