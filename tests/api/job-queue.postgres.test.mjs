import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const databaseUrl = process.env.AVCU_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const { migrate, query, close } = await import('../../server/db.js');
const queue = await import('../../server/job-queue.js');
const { registerTeams } = await import('../../server/team-runtime.js');

test('PostgreSQL queue: leasing, concurrency, ack ownership, retry, dead-letter and lease recovery', {
  skip: !databaseUrl ? 'Set AVCU_TEST_DATABASE_URL to a dedicated disposable PostgreSQL database.' : false
}, async t => {
  const teamId = 'member-experience';
  const serviceId = 'integration-test-worker';
  const token = 'integration-test-secret-' + randomUUID() + '-0123456789';
  const workerA = 'integration-worker-a-' + randomUUID();
  const workerB = 'integration-worker-b-' + randomUUID();
  const prefix = 'pg-it-' + randomUUID();
  const ids = [];
  process.env.AVCU_SERVICE_TOKEN_INTEGRATION_TEST_WORKER = token;

  try {
    await migrate();
    await registerTeams();
    await queue.registerServiceIdentity({teamId,serviceId,capabilities:['member.support']});
    await query("UPDATE avcu_team_runtime SET desired_state='ACTIVE',lifecycle_state='ACTIVE' WHERE team_id=$1",[teamId]);

    const enqueue = async (suffix, maxAttempts=3) => {
      const job = await queue.enqueueJob({
        teamId,serviceId,jobType:'member.task',payload:{taskType:suffix,marker:prefix},
        idempotencyKey:prefix+'-'+suffix,maxAttempts
      });
      ids.push(job.id);
      return job;
    };

    await t.test('idempotency key cannot silently alias a different payload', async () => {
      await enqueue('idempotency');
      await assert.rejects(
        queue.enqueueJob({teamId,serviceId,jobType:'member.task',payload:{taskType:'changed'},idempotencyKey:prefix+'-idempotency'}),
        /idempotency key conflicts/
      );
    });

    await t.test('two workers claim distinct jobs concurrently', async () => {
      await enqueue('parallel-a');
      await enqueue('parallel-b');
      const claims = await Promise.all([
        queue.claimJob({teamId,serviceId,workerId:workerA,leaseSeconds:60}),
        queue.claimJob({teamId,serviceId,workerId:workerB,leaseSeconds:60})
      ]);
      assert.ok(claims.every(Boolean));
      assert.notEqual(claims[0].id,claims[1].id);
      ids.push(claims[0].id,claims[1].id);
    });

    await t.test('acknowledgement requires the current lease owner and token', async () => {
      const job = await enqueue('ack');
      const lease = await queue.claimJob({teamId,serviceId,workerId:workerA,leaseSeconds:60});
      assert.equal(lease.id,job.id);
      await assert.rejects(queue.acknowledgeJob({jobId:job.id,leaseToken:lease.lease_token,workerId:workerB,result:{ok:true}}),{status:409});
      const ack = await queue.acknowledgeJob({jobId:job.id,leaseToken:lease.lease_token,workerId:workerA,result:{ok:true}});
      assert.equal(ack.status,'succeeded');
      await assert.rejects(queue.acknowledgeJob({jobId:job.id,leaseToken:lease.lease_token,workerId:workerA,result:{ok:true}}),{status:409});
    });

    await t.test('retry schedules bounded backoff and permits a later claim', async () => {
      const job = await enqueue('retry',3);
      const lease = await queue.claimJob({teamId,serviceId,workerId:workerA,leaseSeconds:60});
      assert.equal(lease.id,job.id);
      const failed = await queue.failJob({jobId:job.id,leaseToken:lease.lease_token,workerId:workerA,errorCode:'temporary_failure',retryable:true});
      assert.equal(failed.status,'retry_wait');
      assert.ok(failed.nextDelaySeconds>=5 && failed.nextDelaySeconds<=3600);
      await query("UPDATE avcu_jobs SET available_at=now() WHERE id=$1",[job.id]);
      const secondLease = await queue.claimJob({teamId,serviceId,workerId:workerB,leaseSeconds:60});
      assert.equal(secondLease.id,job.id);
      assert.equal(secondLease.attempts,2);
    });

    await t.test('non-retryable failures enter the dead-letter table', async () => {
      const job = await enqueue('dead-letter',1);
      const lease = await queue.claimJob({teamId,serviceId,workerId:workerA,leaseSeconds:60});
      assert.equal(lease.id,job.id);
      const failed = await queue.failJob({jobId:job.id,leaseToken:lease.lease_token,workerId:workerA,errorCode:'permanent_failure',retryable:false});
      assert.equal(failed.status,'dead_letter');
      const row = await query('SELECT final_error_code,attempts FROM avcu_job_dead_letters WHERE job_id=$1',[job.id]);
      assert.equal(row.rows[0].final_error_code,'permanent_failure');
      assert.equal(row.rows[0].attempts,1);
    });

    await t.test('expired leases are recovered and recorded before re-claim', async () => {
      const job = await enqueue('lease-recovery',3);
      const lease = await queue.claimJob({teamId,serviceId,workerId:workerA,leaseSeconds:60});
      assert.equal(lease.id,job.id);
      await query("UPDATE avcu_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[job.id]);
      await queue.claimJob({teamId,serviceId,workerId:workerB,leaseSeconds:60});
      const row = await query('SELECT status,attempts FROM avcu_jobs WHERE id=$1',[job.id]);
      assert.equal(row.rows[0].status,'retry_wait');
      const event = await query("SELECT count(*)::int AS n FROM avcu_job_events WHERE job_id=$1 AND event_type='job.lease_expired'",[job.id]);
      assert.equal(event.rows[0].n,1);
    });

    await t.test('revoked service identities cannot claim additional work', async () => {
      await enqueue('revocation');
      await query('UPDATE avcu_service_identities SET active=false WHERE service_id=$1',[serviceId]);
      assert.equal(await queue.claimJob({teamId,serviceId,workerId:workerA}),null);
    });
  } finally {
    if (ids.length) {
      await query('DELETE FROM avcu_job_dead_letters WHERE job_id=ANY($1::uuid[])',[ids]).catch(()=>{});
      await query('DELETE FROM avcu_job_events WHERE job_id=ANY($1::uuid[])',[ids]).catch(()=>{});
      await query('DELETE FROM avcu_jobs WHERE id=ANY($1::uuid[])',[ids]).catch(()=>{});
    }
    await query('DELETE FROM avcu_service_identities WHERE service_id=$1',[serviceId]).catch(()=>{});
    await query("UPDATE avcu_team_runtime SET desired_state='PAUSED',lifecycle_state='PAUSED' WHERE team_id=$1",[teamId]).catch(()=>{});
    delete process.env.AVCU_SERVICE_TOKEN_INTEGRATION_TEST_WORKER;
    await close();
  }
});
