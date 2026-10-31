import { randomUUID } from 'node:crypto';
import { close, query } from './db.js';
import { heartbeat, claimJob, acknowledgeJob, failJob, renewJobLease, validateWorkerIdentity, serviceSecret } from './job-queue.js';

const teamId=process.env.AVCU_WORKER_TEAM;
const serviceId=process.env.AVCU_WORKER_SERVICE_ID;
const workerId=process.env.AVCU_WORKER_ID || randomUUID();
const token=serviceSecret(serviceId);
if(!teamId||!serviceId||!token) throw new Error('Worker team, service identity and scoped service token must be configured.');

const handlers=new Map();
handlers.set('risk.evaluate',async payload=>({accepted:true,mode:'policy-only',receivedKeys:Object.keys(payload||{}).slice(0,20)}));
handlers.set('member.task',async payload=>({accepted:true,mode:'internal-task',taskType:String(payload?.taskType||'unspecified').slice(0,80)}));
handlers.set('travel.search',async()=>{const e=new Error('No approved live travel provider adapter is configured.');e.code='provider_not_configured';e.retryable=false;throw e;});
handlers.set('ai.respond',async()=>{const e=new Error('No approved production AI provider adapter is configured.');e.code='provider_not_configured';e.retryable=false;throw e;});
handlers.set('notification.deliver',async()=>{const e=new Error('Notification delivery must use the approved notification outbox worker.');e.code='wrong_worker';e.retryable=false;throw e;});

let stopping=false,active=null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(){
 await query('SELECT 1');
 if(!await validateWorkerIdentity({teamId,serviceId,token})) throw Object.assign(new Error('Worker service identity is not registered for this team.'),{code:'service_identity_invalid'});
 await heartbeat({workerId,teamId,serviceId,status:'healthy'});
 while(!stopping){
  active=await claimJob({teamId,workerId});
  if(!active){await heartbeat({workerId,teamId,serviceId,status:'healthy'});await sleep(1500);continue;}
  let leaseTimer=null;
  try{
   leaseTimer=setInterval(()=>{void renewJobLease({jobId:active.id,leaseToken:active.lease_token,workerId}).then(ok=>{if(!ok) console.error('[avcu-worker] lease renewal rejected');}).catch(()=>{});},20000);
   leaseTimer.unref?.();
   if(!await validateWorkerIdentity({teamId,serviceId,token})) throw Object.assign(new Error('Service identity rejected.'),{code:'service_identity_invalid',retryable:false});
   const handler=handlers.get(active.job_type);
   if(!handler) throw Object.assign(new Error('No handler registered for job type.'),{code:'handler_missing',retryable:false});
   const result=await handler(active.payload);
   await acknowledgeJob({jobId:active.id,leaseToken:active.lease_token,workerId,result});
  }catch(error){
   await failJob({jobId:active.id,leaseToken:active.lease_token,workerId,errorCode:error.code||'handler_error',retryable:Boolean(error.retryable)});
  }finally{if(leaseTimer) clearInterval(leaseTimer);active=null;}
 }
}
async function shutdown(){
 stopping=true;
 await heartbeat({workerId,teamId,serviceId,status:'stopping',activeJobId:active?.id||null}).catch(()=>{});
 await close();
}
process.once('SIGTERM',()=>void shutdown().then(()=>process.exit(0)));
process.once('SIGINT',()=>void shutdown().then(()=>process.exit(0)));
run().catch(async error=>{console.error('[avcu-worker]',error.code||error.name);await close().catch(()=>{});process.exit(1);});
