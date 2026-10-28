// Notification helpers. Notifications are stored in the database and are never
// the source of truth for money; they only surface recorded activity.
export async function notify(client, { memberId, title, body, kind = 'info' }) {
  const sql = `INSERT INTO notifications (member_id, title, body, kind) VALUES ($1,$2,$3,$4)`;
  const params = [memberId, String(title).slice(0, 120), String(body).slice(0, 600), kind];
  if (client) return client.query(sql, params);
  const { query } = await import('./db.js');
  return query(sql, params);
}

export async function notifyMany(client, memberIds, payload) {
  for (const id of new Set(memberIds.filter(Boolean))) await notify(client, { memberId: id, ...payload });
}
