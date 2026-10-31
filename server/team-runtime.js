import { query, withTx } from './db.js';

export const TEAM_STATES = Object.freeze([
  'PROVISIONING','READY','ACTIVE','DEGRADED','PAUSED','DRAINING','QUARANTINED','DISABLED','FAILED'
]);

export const TEAM_DEFINITIONS = Object.freeze([
  { id:'member-experience', name:'Member Experience', description:'Member-facing journeys, profiles and service requests.', capabilities:['member.read','member.support'], providers:{} },
  { id:'identity-trust', name:'Identity & Trust', description:'Authentication, verification orchestration and account-risk signals.', capabilities:['identity.verify','risk.signal'], providers:{} },
  { id:'payments-ledger', name:'Payments & Ledger', description:'Ledger integrity and payment orchestration; external movement remains policy-locked.', capabilities:['ledger.read','payment.propose'], providers:{} },
  { id:'cards-lending', name:'Cards & Lending', description:'Card and lending application workflows; issuance and funding remain policy-locked.', capabilities:['cards.request','loans.apply'], providers:{} },
  { id:'communications', name:'Communications', description:'Consent-aware email and notification delivery.', capabilities:['notifications.send'], providers:{} },
  { id:'travel', name:'Travel', description:'Travel discovery and provider-backed booking workflows.', capabilities:['travel.search'], providers:{} },
  { id:'ai-orchestration', name:'AI Orchestration', description:'Provider-neutral AI requests with server-validated tools.', capabilities:['ai.respond'], providers:{} },
  { id:'risk-compliance', name:'Risk & Compliance', description:'Policy checks, evidence capture and exception monitoring.', capabilities:['policy.evaluate','audit.read'], providers:{} },
  { id:'operations', name:'Operations & Reliability', description:'Health, queues, incident response and service recovery.', capabilities:['runtime.monitor','runtime.control'], providers:{} }
]);

const transitions = Object.freeze({
  PROVISIONING: new Set(['READY','FAILED','DISABLED']),
  READY: new Set(['ACTIVE','PAUSED','DISABLED','FAILED']),
  ACTIVE: new Set(['DEGRADED','PAUSED','DRAINING','QUARANTINED','DISABLED','FAILED']),
  DEGRADED: new Set(['READY','ACTIVE','PAUSED','DRAINING','QUARANTINED','DISABLED','FAILED']),
  PAUSED: new Set(['READY','ACTIVE','QUARANTINED','DISABLED','FAILED']),
  DRAINING: new Set(['PAUSED','READY','QUARANTINED','FAILED']),
  QUARANTINED: new Set(['PAUSED','DISABLED','FAILED']),
  DISABLED: new Set(['PROVISIONING']),
  FAILED: new Set(['PROVISIONING','DISABLED'])
});

export function canTransition(from, to) {
  return TEAM_STATES.includes(from) && TEAM_STATES.includes(to) && (from === to || Boolean(transitions[from]?.has(to)));
}

export function assertOperator(actor) {
  if (!actor || actor.type !== 'operator' || !['management','super_admin','admin'].includes(actor.role)) {
    const error = new Error('An authenticated, authorized operator is required.');
    error.status = 403;
    throw error;
  }
}

export async function registerTeams() {
  for (const team of TEAM_DEFINITIONS) {
    await query(
      `INSERT INTO avcu_team_runtime (team_id,display_name,description,lifecycle_state,desired_state,capabilities,provider_bindings)
       VALUES ($1,$2,$3,'PROVISIONING','PAUSED',$4::jsonb,$5::jsonb)
       ON CONFLICT (team_id) DO NOTHING`,
      [team.id,team.name,team.description,JSON.stringify(team.capabilities),JSON.stringify(team.providers)]
    );
  }
}

export async function listTeams() {
  const result = await query(
    `SELECT team_id,display_name,description,lifecycle_state,desired_state,version,capabilities,provider_bindings,health,last_heartbeat_at,updated_at
     FROM avcu_team_runtime ORDER BY team_id`
  );
  return result.rows;
}

export async function controlTeam({ teamId, desiredState, reason, actor, correlationId = null }) {
  assertOperator(actor);
  if (!TEAM_STATES.includes(desiredState) || !['READY','ACTIVE','PAUSED','DRAINING','QUARANTINED','DISABLED'].includes(desiredState)) {
    const error = new Error('Unsupported team state.');
    error.status = 400;
    throw error;
  }
  if (typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 500) {
    const error = new Error('A control reason of 8–500 characters is required.');
    error.status = 400;
    throw error;
  }
  return withTx(async client => {
    const current = await client.query('SELECT * FROM avcu_team_runtime WHERE team_id=$1 FOR UPDATE',[teamId]);
    if (!current.rowCount) {
      const error = new Error('Team not found.');
      error.status = 404;
      throw error;
    }
    const row = current.rows[0];
    if (!canTransition(row.lifecycle_state, desiredState)) {
      const error = new Error(`Transition ${row.lifecycle_state} -> ${desiredState} is not allowed.`);
      error.status = 409;
      throw error;
    }
    const updated = await client.query(
      `UPDATE avcu_team_runtime SET desired_state=$2, lifecycle_state=$2, version=version+1, updated_at=now()
       WHERE team_id=$1 RETURNING team_id,lifecycle_state,desired_state,version,updated_at`,
      [teamId,desiredState]
    );
    await client.query(
      `INSERT INTO avcu_team_control_events
       (team_id,actor_type,actor_id,actor_role,action,previous_state,next_state,reason,correlation_id,metadata)
       VALUES ($1,'operator',$2,$3,'team.state.requested',$4,$5,$6,$7,$8::jsonb)`,
      [teamId,actor.id || null,actor.role,row.lifecycle_state,desiredState,reason.trim(),correlationId,JSON.stringify({version:updated.rows[0].version})]
    );
    return updated.rows[0];
  });
}

export async function recordTeamHeartbeat({ teamId, status, metadata = {} }) {
  if (!['READY','ACTIVE','DEGRADED','FAILED'].includes(status)) throw new Error('Invalid heartbeat status.');
  const safeMetadata = JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {});
  const result = await query(
    `UPDATE avcu_team_runtime SET lifecycle_state=CASE
       WHEN desired_state IN ('PAUSED','DRAINING','QUARANTINED','DISABLED') THEN desired_state
       ELSE $2 END,
       health=$3::jsonb,last_heartbeat_at=now(),updated_at=now(),version=version+1
     WHERE team_id=$1 AND desired_state NOT IN ('DISABLED','QUARANTINED')
     RETURNING team_id,lifecycle_state,desired_state,version,last_heartbeat_at`,
    [teamId,status,safeMetadata]
  );
  return result.rows[0] || null;
}
