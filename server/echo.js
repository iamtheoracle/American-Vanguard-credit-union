import { withTx, query, audit } from './db.js';

/**
 * ECHO AVCU event queue. Transaction status changes are captured in PostgreSQL
 * by migration 999_echo_voice.sql in the same transaction as the source update.
 * No calls are placed until a production voice provider, verified phone, and
 * recorded customer consent are configured.
 */
export async function getEchoMemberStatus(memberId) {
  const [preferences, events] = await Promise.all([
    query(
      \`SELECT phone_e164 IS NOT NULL AS "phonePresent",
              phone_verified_at IS NOT NULL AS "phoneVerified",
              voice_consent AS "voiceConsent",
              voice_consent_at AS "consentAt",
              voice_consent_revoked_at AS "consentRevokedAt"
       FROM member_voice_preferences WHERE member_id = $1\`,
      [memberId]),
    query(
      \`SELECT transaction_status AS status, count(*)::int AS count
       FROM echo_call_outbox WHERE member_id = $1
       GROUP BY transaction_status ORDER BY transaction_status\`,
      [memberId])
  ]);
  return {
    configured: Boolean(preferences.rows[0]?.phonePresent && preferences.rows[0]?.phoneVerified),
    consent: preferences.rows[0]?.voiceConsent === true && !preferences.rows[0]?.consentRevokedAt,
    events: events.rows
  };
}

/** Dispatch remains deliberately disabled until a production voice adapter exists. */
export async function inspectEchoQueue({ limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const { rows } = await query(
    \`SELECT status, transaction_status AS "transactionStatus", count(*)::int AS count
     FROM echo_call_outbox GROUP BY status, transaction_status
     ORDER BY status, transaction_status\`);
  return { dispatchEnabled: false, grouped: rows, limit: safeLimit };
}

/** Consent may only be enabled after an independently verified phone challenge. */
export async function setEchoVoiceConsent({ memberId, phoneE164, verifiedAt, consent, source }) {
  if (consent !== true) throw new Error('Consent may only be enabled through the verified consent workflow');
  if (typeof phoneE164 !== 'string' || !/^\\+[1-9][0-9]{7,14}$/.test(phoneE164)) {
    throw new Error('A verified E.164 phone number is required');
  }
  if (!verifiedAt) throw new Error('Phone verification is required');
  return withTx(async client => {
    const verified = await client.query(
      'SELECT id FROM members WHERE id = $1 AND status = $2 FOR UPDATE', [memberId, 'verified']);
    if (!verified.rows[0]) throw new Error('Verified AVCU membership is required');
    await client.query(
      \`INSERT INTO member_voice_preferences
        (member_id, phone_e164, phone_verified_at, voice_consent,
         voice_consent_at, voice_consent_source, voice_consent_revoked_at, updated_at)
       VALUES ($1,$2,$3,TRUE,now(),$4,NULL,now())
       ON CONFLICT (member_id) DO UPDATE SET
         phone_e164 = EXCLUDED.phone_e164, phone_verified_at = EXCLUDED.phone_verified_at,
         voice_consent = TRUE, voice_consent_at = now(),
         voice_consent_source = EXCLUDED.voice_consent_source,
         voice_consent_revoked_at = NULL, updated_at = now()\`,
      [memberId, phoneE164, verifiedAt, String(source || 'unverified_source').slice(0, 80)]);
    await client.query(
      \`UPDATE echo_call_outbox SET status = 'pending', updated_at = now()
       WHERE member_id = $1 AND status = 'suppressed'\`, [memberId]);
    await audit(client, {
      actorType: 'member', actorId: memberId, action: 'echo.voice_consent.enabled',
      entityType: 'member_voice_preferences', entityId: memberId,
      metadata: { phoneVerified: true, consentSource: String(source || '').slice(0, 80) }
    });
    return { consent: true, phoneVerified: true, dispatchEnabled: false };
  });
}

export async function revokeEchoVoiceConsent(memberId) {
  return withTx(async client => {
    await client.query(
      \`UPDATE member_voice_preferences
       SET voice_consent = FALSE, voice_consent_revoked_at = now(), updated_at = now()
       WHERE member_id = $1\`, [memberId]);
    await audit(client, {
      actorType: 'member', actorId: memberId, action: 'echo.voice_consent.revoked',
      entityType: 'member_voice_preferences', entityId: memberId
    });
    return { consent: false };
  });
}
