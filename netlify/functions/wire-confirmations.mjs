import { getDatabase } from "@netlify/database";
import { getUser } from "@netlify/identity";

const json = (body, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
});
const fail = (status, message) => json({ error: message }, status);
const clean = (v, max = 240) => typeof v === "string" ? v.trim().slice(0, max) : "";
const has = (user, role) => Array.isArray(user?.roles) && user.roles.includes(role);
const roles = ["wire_operations_admin", "wire_evidence_submitter", "wire_confirmation_approver"];

async function authenticate(req, write = false) {
  if (write) {
    const origin = req.headers.get("origin");
    if (!origin || origin !== new URL(req.url).origin) return null;
  }
  const user = await getUser();
  if (!user?.id || !roles.some(role => has(user, role))) return null;
  return user;
}

export default async function handler(req) {
  if (!["GET", "POST"].includes(req.method)) {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }
  let actor;
  try { actor = await authenticate(req, req.method === "POST"); }
  catch { return fail(401, "Sign in with an authorized wire-operations account."); }
  if (!actor) return fail(403, "Dedicated wire-operations access is required.");

  try {
    const db = getDatabase();
    if (req.method === "GET") {
      const rows = await db.sql`
        SELECT c.id, c.sender_name, c.beneficiary_name, c.purpose, c.amount::text,
               c.currency, c.destination_institution, c.external_reference,
               c.status, c.created_at, c.updated_at,
               COALESCE((SELECT json_agg(json_build_object(
                 'id', e.id, 'evidence_reference', e.evidence_reference,
                 'evidence_summary', e.evidence_summary,
                 'submitted_by', e.submitted_by, 'created_at', e.created_at
               ) ORDER BY e.created_at DESC)
               FROM external_wire_evidence e WHERE e.case_id = c.id), '[]'::json) AS evidence,
               COALESCE((SELECT json_agg(json_build_object(
                 'action', a.action, 'actor_identity_user_id', a.actor_identity_user_id,
                 'note', a.note, 'created_at', a.created_at
               ) ORDER BY a.created_at DESC)
               FROM external_wire_review_events a WHERE a.case_id = c.id), '[]'::json) AS history
        FROM external_wire_cases c ORDER BY c.created_at DESC LIMIT 200
      `;
      return json({ cases: rows, permissions: {
        create: has(actor, "wire_operations_admin"),
        submitEvidence: has(actor, "wire_evidence_submitter"),
        decide: has(actor, "wire_confirmation_approver")
      }});
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "A valid JSON object is required.");
    const action = clean(body.action, 32);
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      if (action === "create") {
        if (!has(actor, "wire_operations_admin")) { await client.query("ROLLBACK"); return fail(403, "Wire operations administrator role required."); }
        const sender = clean(body.senderName,160), beneficiary = clean(body.beneficiaryName,160);
        const purpose = clean(body.purpose,120), institution = clean(body.destinationInstitution,160);
        const reference = clean(body.externalReference,160), currency = clean(body.currency,3).toUpperCase();
        const amount = clean(String(body.amount ?? ""),32);
        if ([sender,beneficiary,purpose,institution,reference].some(v=>v.length<2) ||
            !/^[A-Z]{3}$/.test(currency) || !/^(?:0|[1-9][0-9]{0,13})(?:\\.[0-9]{1,2})?$/.test(amount) || Number(amount)<=0) {
          await client.query("ROLLBACK"); return fail(400,"Complete all case fields with a positive amount and three-letter currency.");
        }
        const inserted = await client.query(
          "INSERT INTO external_wire_cases (sender_name,beneficiary_name,purpose,amount,currency,destination_institution,external_reference,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
          [sender,beneficiary,purpose,amount,currency,institution,reference,String(actor.id)]
        );
        const id=inserted.rows[0].id;
        await client.query("INSERT INTO external_wire_review_events (case_id,actor_identity_user_id,action,note) VALUES ($1,$2,'case_created',$3)",[id,String(actor.id),"External wire case registered for evidence review; no payment action performed."]);
        await client.query("COMMIT"); return json({ok:true,id,status:"awaiting_evidence"},201);
      }

      const caseId=clean(body.caseId,80);
      const found=await client.query("SELECT id,status FROM external_wire_cases WHERE id=$1 FOR UPDATE",[caseId]);
      if (!found.rows.length) { await client.query("ROLLBACK"); return fail(404,"Wire case not found."); }
      const current=found.rows[0];
      if (action === "submit_evidence") {
        if (!has(actor,"wire_evidence_submitter")) { await client.query("ROLLBACK"); return fail(403,"Evidence submitter role required."); }
        if (current.status!=="awaiting_evidence") { await client.query("ROLLBACK"); return fail(409,"This case is not awaiting evidence."); }
        const ref=clean(body.evidenceReference,240), summary=clean(body.evidenceSummary,1000), note=clean(body.note,1000);
        if (!/^vault:[A-Za-z0-9/_-]{6,220}$/.test(ref) || summary.length<10 || note.length<3) {
          await client.query("ROLLBACK"); return fail(400,"Use a private vault reference, evidence summary and review note. Public URLs are not accepted.");
        }
        const evidence=await client.query("INSERT INTO external_wire_evidence (case_id,evidence_reference,evidence_summary,submitted_by) VALUES ($1,$2,$3,$4) RETURNING id",[caseId,ref,summary,String(actor.id)]);
        await client.query("UPDATE external_wire_cases SET status='evidence_submitted',updated_at=NOW() WHERE id=$1",[caseId]);
        await client.query("INSERT INTO external_wire_review_events (case_id,evidence_id,actor_identity_user_id,action,note) VALUES ($1,$2,$3,'evidence_submitted',$4)",[caseId,evidence.rows[0].id,String(actor.id),note]);
        await client.query("COMMIT"); return json({ok:true,status:"evidence_submitted"});
      }
      if (action === "decide") {
        if (!has(actor,"wire_confirmation_approver")) { await client.query("ROLLBACK"); return fail(403,"Wire confirmation approver role required."); }
        const decision=clean(body.decision,24), note=clean(body.note,1000);
        if (!["confirmed","rejected","escalated"].includes(decision) || note.length<10) {
          await client.query("ROLLBACK"); return fail(400,"Choose confirm, reject or escalate and provide a reason of at least 10 characters.");
        }
        const evidence=await client.query("SELECT submitted_by FROM external_wire_evidence WHERE case_id=$1 ORDER BY created_at DESC LIMIT 1",[caseId]);
        if (current.status!=="evidence_submitted" || !evidence.rows.length) { await client.query("ROLLBACK"); return fail(409,"Evidence must be submitted before review."); }
        if (evidence.rows[0].submitted_by===String(actor.id)) { await client.query("ROLLBACK"); return fail(403,"The evidence submitter cannot approve or reject the same case."); }
        const latest=await client.query("SELECT id FROM external_wire_evidence WHERE case_id=$1 ORDER BY created_at DESC LIMIT 1",[caseId]);
        await client.query("UPDATE external_wire_cases SET status=$2,updated_at=NOW() WHERE id=$1",[caseId,decision]);
        await client.query("INSERT INTO external_wire_review_events (case_id,evidence_id,actor_identity_user_id,action,note) VALUES ($1,$2,$3,$4,$5)",[caseId,latest.rows[0].id,String(actor.id),decision,note]);
        await client.query("COMMIT"); return json({ok:true,status:decision,financialEffect:"none"});
      }
      await client.query("ROLLBACK"); return fail(400,"Unsupported action.");
    } catch(error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
  } catch(error) {
    console.error("Wire confirmation API failed",{requestId:req.headers.get("x-nf-request-id")||"unknown",name:error?.name});
    return fail(503,"Wire confirmation service unavailable. No financial action was performed.");
  }
}

export const config = { path: "/api/admin/wire-confirmations", method: ["GET","POST"], rateLimit: { action: "rate_limit", aggregateBy: "ip", windowSize: 60, windowLimit: 30 } };
