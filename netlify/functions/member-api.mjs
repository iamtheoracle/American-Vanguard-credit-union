import { getDatabase } from "@netlify/database";
import { getUser } from "@netlify/identity";

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
});
const fail = (status, message) => json({ error: message }, status);
const clean = (value, max = 2000) => typeof value === "string" ? value.trim().slice(0, max) : "";

export default async function handler(req) {
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }
  if (!req.headers.get("authorization")?.startsWith("Bearer ")) return fail(401, "Sign in to continue.");
  let user;
  try { user = await getUser(); } catch { return fail(401, "Your session could not be verified. Sign in again."); }
  if (!user?.id || !user.email) return fail(401, "Sign in to continue.");
  try {
    const db = getDatabase();
    if (req.method === "GET") {
      const rows = await db.sql`
        SELECT a.id AS application_id, a.full_name, a.status AS application_status,
               a.created_at AS application_created_at, a.updated_at AS application_updated_at,
               v.id AS verification_request_id, v.applicant_statement,
               v.status AS verification_status, v.created_at AS verification_created_at
        FROM member_applications a
        LEFT JOIN LATERAL (
          SELECT id, applicant_statement, status, created_at
          FROM verification_requests
          WHERE application_id = a.id
          ORDER BY created_at DESC LIMIT 1
        ) v ON TRUE
        WHERE a.identity_user_id = ${String(user.id)}
        LIMIT 1
      `;
      return json({ application: rows[0] || null });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return fail(400, "Submit a valid application.");
    const fullName = clean(body.fullName, 160);
    const statement = clean(body.statement, 2000);
    if (fullName.length < 2 || statement.length < 10) {
      return fail(400, "Enter your full legal name and a short statement of at least 10 characters.");
    }

    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT id, status FROM member_applications WHERE identity_user_id = $1 FOR UPDATE",
        [String(user.id)]
      );
      let applicationId;
      if (existing.rows.length) {
        const prior = existing.rows[0];
        if (prior.status === "approved") {
          await client.query("ROLLBACK");
          return fail(409, "Your application is already approved. Contact support if your details need updating.");
        }
        if (prior.status === "pending") {
          await client.query("ROLLBACK");
          return fail(409, "Your application is already pending review.");
        }
        applicationId = prior.id;
        await client.query(
          "UPDATE member_applications SET full_name = $2, email = $3, status = 'pending', updated_at = NOW() WHERE id = $1",
          [applicationId, fullName, String(user.email).toLowerCase()]
        );
      } else {
        const created = await client.query(
          "INSERT INTO member_applications (identity_user_id, email, full_name, status) VALUES ($1,$2,$3,'pending') RETURNING id",
          [String(user.id), String(user.email).toLowerCase(), fullName]
        );
        applicationId = created.rows[0].id;
      }
      await client.query(
        "INSERT INTO verification_requests (application_id, identity_user_id, applicant_statement, status) VALUES ($1,$2,$3,'pending')",
        [applicationId, String(user.id), statement]
      );
      await client.query("COMMIT");
      return json({ ok: true, status: "pending", message: "Application submitted for review. It is not approved yet." }, 201);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } catch (error) {
    console.error("Member API request failed", { requestId: req.headers.get("x-nf-request-id") || "unknown", name: error?.name });
    return fail(503, "Member onboarding is temporarily unavailable. Please try again later.");
  }
}

export const config = { path: "/api/member", method: ["GET", "POST"], rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 30 } };