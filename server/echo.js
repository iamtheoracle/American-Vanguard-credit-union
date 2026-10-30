import { withTx, query, audit } from './db.js';

/**
 * ECHO AVCU event queue. Transaction status changes are captured in PostgreSQL
 * by migration 999_echo_voice.sql in the same transaction as the source update.
 * Dispatch is disabled until KMS-backed phone encryption, verified consent,
 * and a production voice provider are implemented and approved.
 */
export async function getEchoMemberStatus(memberId) {
  const [preferences, events] = await Promise.all([
    query(
      `SELECT phone_ciphertext IS NOT NULL AS "phonePresent",
              phone_verified_at IS NOT NULL AS "phoneVerified",
              voice_consent AS "voiceConsent",
              voice_consent_at AS "consentAt",
              voice_consent_revoked_at AS "consentRevokedAt"
       FROM member_voice_preferences WHERE member_id = $1`,
      [memberId]),
    query(
      `SELECT transaction_status AS status, count(*)::int AS count
       FROM echo_call_outbox WHERE member_id = $1
       GROUP BY transaction_status ORDER BY transaction_status`,
      [memberId])
  ]);
  return {
    configured: Boolean(preferences.rows[0]?.phonePresent && preferences.rows[0]?.phoneVerified),
    consent: preferences.rows[0]?.voiceConsent === true && !preferences.rows[0]?.consentRevokedAt,
    events: events.rows
  };
}

export async function inspectEchoQueue() {
  const { rows } = await query(
    `SELECT status, transaction_status AS "transactionStatus", count(*)::int AS count
     FROM echo_call_outbox GROUP BY status, transaction_status
     ORDER BY status, transaction_status`);
  return { dispatchEnabled: false, grouped: rows };
}

/** Revocation is available immediately; activation awaits a verified consent workflow. */
export async function revokeEchoVoiceConsent(memberId) {
  return withTx(async client => {
    await client.query(
      `UPDATE member_voice_preferences
       SET voice_consent = FALSE, voice_consent_revoked_at = now(), updated_at = now()
       WHERE member_id = $1`, [memberId]);
    await audit(client, {
      actorType: 'member', actorId: memberId, action: 'echo.voice_consent.revoked',
      entityType: 'member_voice_preferences', entityId: memberId
    });
    return { consent: false };
  });
}
