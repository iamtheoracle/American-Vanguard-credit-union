import { getDatabase } from "@netlify/database";
import { getUser } from "@netlify/identity";

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
});
const fail = (status, message) => json({ error: message }, status);
const clean = (value, max = 2000) => typeof value === "string" ? value.trim().slice(0, max) : "";

async function authorizedStaff(req) {
  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (!origin || origin !== new URL(req.url).origin) return null;
  }
  const user = await getUser();
  if (!user?.id || !Array.isArray(user.roles) || !user.roles.includes("admin")) return null;
  return user;
}

export default async function handler(req) {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }
  let staff;
  try { staff = await authorizedStaff(req); } catch { return fail(401, "Sign in with an authorized staff account."); }
  if (!staff) return fail(403, "Staff access is required.");
  try {
    const db = getDatabase();
    if (req.method === "GET") {
      const rows = await db.sql`
        SELECT a.id AS application_id, a.full_name, a.email,
               a.status AS application_status, a.created_at AS application_created_at,
               v.id AS verification_request_id, v.applicant_statement,
               v.status AS verification_status, v.created_at AS verification_created_at,
               COALESCE((
                 SELECT json_agg(json_build_object(
                   'decision', e.decision, 'note', e.note,
                   'reviewer_identity_user_id', e.reviewer_identity_user_id,
                   'created_at', e.created_at
                 ) ORDER BY e.created_at DESC)
                 FROM verification_review_events e WHERE e.application_id = a.id
               ), '[]'::json) AS review_history
        FROM member_applications a
        JOIN LATERAL (
          SELECT id, applicant_statement, status, created_at
          FROM verification_requests WHERE application_id = a.id
          ORDER BY created_at DESC LIMIT 1
        ) v ON TRUE
        ORDER BY CASE WHEN v.status = 'pending' THEN 0 WHEN v.status = 'resubmission' THEN 1 ELSE 2 END,
                 v.created_at DESC
        LIMIT 200
      `;
      return json({ reviews: rows });
    }
    const body = await req.json().catch(() => null);
    const requestId = clean(body?.verificationRequestId, 80);
    const decision = clean(body?.decision, 32);
    const note = clean(body?.note, 2000);
    if (!requestId || !["approved", "rejected", "resubmission"].includes(decision) || note.length < 3) {
      return fail(400, "Choose a valid decision and provide a review note of at least 3 characters.");
    }
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query(
        "SELECT id, application_id, status FROM verification_requests WHERE id = $1 FOR UPDATE",
        [requestId]
      );
      if (!found.rows.length) {
        await client.query("ROLLBACK");
        return fail(404, "Verification request not found.");
      }
      const current = found.rows[0];
      if (!["pending", "resubmission"].includes(current.status)) {
        await client.query("ROLLBACK");
        return fail(409, "This request has already been decided. Review the latest request instead.");
      }
      await client.query(
        "UPDATE verification_requests SET status = $2, updated_at = NOW() WHERE id = $1",
        [requestId, decision]
      );
      await client.query(
        "UPDATE member_applications SET status = $2, updated_at = NOW() WHERE id = $1",
        [current.application_id, decision]
      );
      await client.query(
        "INSERT INTO verification_review_events (application_id, verification_request_id, reviewer_identity_user_id, decision, note) VALUES ($1,$2,$3,$4,$5)",
        [current.application_id, requestId, String(staff.id), decision, note]
      );
      await client.query("COMMIT");
      return json({ ok: true, decision, message: "Decision and review note recorded." });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } catch (error) {
    console.error("Admin review API failed", { requestId: req.headers.get("x-nf-request-id") || "unknown", name: error?.name });
    return fail(503, "Review service is temporarily unavailable. No decision was recorded.");
  }
}

export const config = { path: "/api/admin/reviews", method: ["GET", "POST"], rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 60 } };