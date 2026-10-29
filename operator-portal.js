(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let operator = null;
  let auditEvents = [];
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const notice = (id,text,error=false) => { $(id).textContent=text||''; $(id).classList.toggle('error',error); };
  async function api(path, options={}) {
    const response = await fetch('/api'+path,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||`Request failed (${response.status})`);
    return data;
  }
  const post=(path,body)=>api(path,{method:'POST',body:JSON.stringify(body)});
  function setAuthed(value){$('operator-auth').classList.toggle('hidden',value);$('operator-dashboard').classList.toggle('hidden',!value);}
  async function loadApprovals(){
    const data=await api('/operator/approvals');
    $('approval-list').innerHTML=data.approvals?.length? `<table><thead><tr><th>Type</th><th>Member / reference</th><th>Amount</th><th>Status</th><th>Required role</th><th>Actions</th></tr></thead><tbody>${data.approvals.map(a=>`<tr><td>${esc(a.itemType)}</td><td><strong>${esc(a.memberName||a.reference||a.id)}</strong><small>${esc(a.memberEmail||a.transactionType||a.requestType||'')}</small></td><td>${a.amountCents==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(a.amountCents)/100)}</td><td><span class="status-pill">${esc(a.status.replaceAll('_',' '))}</span></td><td>${esc(a.requiredRole)}</td><td class="action-cell">${['pending','escalated'].includes(a.status)?`<button class="mini-action" data-approval="${esc(a.id)}" data-item-type="${esc(a.itemType)}" data-action="approve">Approve</button><button class="mini-action danger-action" data-approval="${esc(a.id)}" data-action="reject">Reject</button><button class="mini-action" data-approval="${esc(a.id)}" data-action="request_info">Request info</button><button class="mini-action" data-approval="${esc(a.id)}" data-action="escalate">Escalate</button>`:'—'}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No approvals in this queue.</p>';
    $('approval-list').querySelectorAll('[data-approval]').forEach(button=>button.addEventListener('click',async()=>{
      const action=button.dataset.action;
      let reason='';
      if(action==='reject'||action==='escalate'||action==='request_info'||(action==='approve'&&['loan','money_request'].includes(button.dataset.itemType))){reason=window.prompt(action==='reject'?'Enter the reason for rejection:':action==='request_info'?'Describe the additional information required:':action==='approve'?'Enter the management decision reason:':'Enter why this item needs escalation:')||'';if(!reason.trim())return;}
      try{await api(`/operator/approvals/${encodeURIComponent(button.dataset.approval)}/decide`,{method:'POST',body:JSON.stringify({action,reason})});notice('operator-message',`Approval ${action} request processed.`);await loadAll();}
      catch(error){notice('operator-message',error.message,true);}
    }));
  }
  async function loadLoanAlerts(){
    const data = await api('/operator/loan-alerts?status=pending');
    const alerts = data.alerts || [];
    $('loan-alert-list').innerHTML = alerts.length ? `<table><thead><tr><th>Submitted</th><th>Reference / member</th><th>Requested amount</th><th>Application status</th><th>Email status</th><th>Action</th></tr></thead><tbody>${alerts.map(alert => `<tr><td>${esc(new Date(alert.submittedAt || alert.createdAt).toLocaleString())}</td><td><strong>${esc(alert.reference)}</strong><small>${esc(alert.memberName)} · ${esc(alert.memberEmail)}</small></td><td>${new Intl.NumberFormat('en-US',{style:'currency',currency:alert.currency||'USD'}).format(Number(alert.requestedAmountCents)/100)}</td><td><span class="status-pill">${esc(String(alert.applicationStatus).replaceAll('_',' '))}</span></td><td><span class="status-pill">${esc(String(alert.emailStatus).replaceAll('_',' '))}</span></td><td><button class="mini-action" data-ack-alert="${esc(alert.id)}">Acknowledge</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No unacknowledged loan alerts.</p>';
    $('loan-alert-list').querySelectorAll('[data-ack-alert]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await post(`/operator/loan-alerts/${encodeURIComponent(button.dataset.ackAlert)}/acknowledge`, {});
        notice('operator-message', 'Loan alert acknowledged and audited.');
        await loadAll();
      } catch (error) {
        notice('operator-message', error.message, true);
        button.disabled = false;
      }
    }));
  }
  async function loadTiers(){
    const params=new URLSearchParams();
    if($('tier-search').value.trim())params.set('search',$('tier-search').value.trim());
    if($('tier-filter-value').value)params.set('tier',$('tier-filter-value').value);
    const data=await api('/operator/membership-tiers?'+params.toString());
    const rows=data.tiers||[];
    $('tier-list').innerHTML=rows.length?`<table><thead><tr><th>Member</th><th>Status</th><th>Current tier</th><th>Activity (90d)</th><th>Override</th><th>Action</th></tr></thead><tbody>${rows.map(m=>`<tr><td><strong>${esc(m.fullName)}</strong><small>${esc(m.email)}</small></td><td>${esc(m.status)}</td><td><span class="status-pill">${esc(String(m.tier).replaceAll('_',' '))}</span>${m.tierOverride?'<small>Manual override</small>':''}</td><td>${esc(m.activity90Days)}</td><td><select aria-label="New tier for ${esc(m.fullName)}" data-tier-select="${esc(m.id)}"><option value="new_member">New Member</option><option value="active_member">Active Member</option><option value="established_member">Established Member</option><option value="priority_service">Priority Service</option><option value="review_required">Review Required</option></select></td><td class="action-cell"><button class="mini-action" data-tier-save="${esc(m.id)}">Set tier</button>${m.tierOverride? `<button class="mini-action" data-tier-clear="${esc(m.id)}">Clear</button>`:''}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No members matched these filters.</p>';
    rows.forEach(m=>{const select=$('tier-list').querySelector(`[data-tier-select="${CSS.escape(m.id)}"]`);if(select)select.value=m.tierOverride||m.tier;});
    $('tier-list').querySelectorAll('[data-tier-save]').forEach(button=>button.addEventListener('click',async()=>{
      const id=button.dataset.tierSave;const select=$('tier-list').querySelector(`[data-tier-select="${CSS.escape(id)}"]`);
      const reason=window.prompt('Enter an audit reason for this tier override:')||'';if(!reason.trim())return;
      try{await api(`/operator/members/${encodeURIComponent(id)}/tier`,{method:'PUT',body:JSON.stringify({tier:select.value,reason})});notice('operator-message','Membership tier updated and audit event recorded.');await loadTiers();}
      catch(error){notice('operator-message',error.message,true);}
    }));
    $('tier-list').querySelectorAll('[data-tier-clear]').forEach(button=>button.addEventListener('click',async()=>{
      if(!window.confirm('Clear this manual override and recalculate the tier?'))return;
      try{await api(`/operator/members/${encodeURIComponent(button.dataset.tierClear)}/tier/override`,{method:'DELETE'});notice('operator-message','Override cleared and tier recalculated.');await loadTiers();}
      catch(error){notice('operator-message',error.message,true);}
    }));
  }
  function renderAudit(){
    const term = String($('audit-search').value || '').toLowerCase().trim();
    const filtered = auditEvents.filter(event => [event.actorId,event.actorRole,event.action,event.entityType,event.entityId].some(value => String(value || '').toLowerCase().includes(term)));
    $('audit-list').innerHTML = filtered.length ? `<table><thead><tr><th>Time</th><th>Actor / role</th><th>Action</th><th>Record</th><th></th></tr></thead><tbody>${filtered.map(event => `<tr><td>${esc(new Date(event.createdAt).toLocaleString())}</td><td>${esc(event.actorId)}<small>${esc(event.actorRole || event.actorType)}</small></td><td>${esc(event.action)}</td><td>${esc(event.entityType)} · ${esc(event.entityId)}</td><td><button class="mini-action" data-audit-detail="${esc(event.id)}">Details</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No audit events match this filter.</p>';
    $('audit-list').querySelectorAll('[data-audit-detail]').forEach(button => button.addEventListener('click', () => {
      const event = auditEvents.find(item => String(item.id) === button.dataset.auditDetail);
      $('audit-detail').textContent = event ? JSON.stringify({ action:event.action, actorId:event.actorId, actorRole:event.actorRole, entityType:event.entityType, entityId:event.entityId, createdAt:event.createdAt, metadata:event.metadata }, null, 2) : '';
    }));
  }
  async function loadAudit(){
    const data = await api('/operator/audit?limit=200');
    auditEvents = data.events || [];
    renderAudit();
  }
  function applyRoleAccess(){
    const role = operator?.role || '';
    document.querySelectorAll('[data-roles]').forEach(panel => {
      const roles = panel.dataset.roles.split(',').map(value => value.trim());
      panel.classList.toggle('hidden', !roles.includes(role));
    });
    $('migration-form').classList.toggle('hidden', role === 'auditor');
  }
  async function loadMigrations(){
    const data = await api('/operator/migrations?limit=10');
    const batches = data.batches || [];
    $('migration-batches').innerHTML = batches.length ? `<table><thead><tr><th>Created</th><th>Source</th><th>Rows</th><th>Exceptions</th><th>Status</th><th>Provenance</th><th></th></tr></thead><tbody>${batches.map(batch => `<tr><td>${esc(new Date(batch.createdAt).toLocaleString())}</td><td>${esc(batch.sourceSystem)}<small>${esc(batch.sourceFileName)}</small></td><td>${esc(batch.acceptedCount)} / ${esc(batch.sourceCount)}</td><td>${esc(batch.exceptionCount)}</td><td><span class="status-pill">${esc(batch.status)}</span></td><td><code>${esc(String(batch.sourcePayloadSha256||'').slice(0,16))}…</code></td><td><button class="mini-action" data-migration-detail="${esc(batch.id)}">Details</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No migration batches have been staged.</p>';
    $('migration-batches').querySelectorAll('[data-migration-detail]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const detail = await api(`/operator/migrations/${encodeURIComponent(button.dataset.migrationDetail)}`);
        $('migration-result').textContent = JSON.stringify(detail, null, 2);
      } catch (error) {
        notice('operator-message', error.message, true);
      } finally { button.disabled = false; }
    }));
  }
  async function loadEmailLog(){
    try{
      const data=await api('/operator/email-deliveries?limit=50');
      $('gmail-config-status').textContent=data.gmailConfigured?'Gmail configured':'Gmail not configured';
      $('gmail-config-status').classList.toggle('good-tag',data.gmailConfigured);
      $('email-log').innerHTML=data.deliveries?.length?`<table><thead><tr><th>Time</th><th>Recipient</th><th>Event</th><th>Subject</th><th>Status</th><th>Error</th></tr></thead><tbody>${data.deliveries.map(e=>`<tr><td>${esc(new Date(e.createdAt).toLocaleString())}</td><td>${esc(e.recipient)}</td><td>${esc(e.eventType)}</td><td>${esc(e.subject)}</td><td><span class="status-pill">${esc(e.status)}</span></td><td>${esc(e.errorCode||'—')}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No email delivery records yet.</p>';
    }catch(error){$('gmail-config-status').textContent='Not available for this role';$('email-log').innerHTML=`<p class="muted">${esc(error.message)}</p>`;}
  }
  async function loadAll(){
    applyRoleAccess();
    if(operator?.role==='auditor'){
      $('queue-approvals').textContent='Read-only';$('queue-members').textContent='—';$('queue-cases').textContent='—';$('queue-loan-alerts').textContent='—';
      await loadMigrations();await loadAudit();return;
    }
    const queue=await api('/operator/queue');
    $('queue-approvals').textContent=Number(queue.approvals?.pending||0)+Number(queue.approvals?.escalated||0);
    $('queue-members').textContent=queue.membershipPending??0;
    $('queue-cases').textContent=queue.cases?.open??0;
    $('queue-loan-alerts').textContent=queue.loanAlertsPending??0;
    await loadLoanAlerts();
    await loadApprovals();
    await loadTiers();
    await loadMigrations();
    if(['management','super_admin'].includes(operator?.role)){await loadAudit();await loadEmailLog();}
  }
  $('operator-login-form').addEventListener('submit',async event=>{
    event.preventDefault();notice('operator-auth-message','Signing in…');
    try{const data=await post('/operator/login',{email:$('operator-email').value,password:$('operator-password').value});operator=data.operator;setAuthed(true);applyRoleAccess();$('operator-identity').textContent=`${operator.name} · ${operator.email} · Role: ${operator.role}`;await loadAll();notice('operator-message','Signed in. Permissions are enforced by the API.');}
    catch(error){notice('operator-auth-message',error.message,true);}
  });
  $('operator-logout').addEventListener('click',async()=>{try{await post('/operator/logout',{});}catch{}operator=null;setAuthed(false);});

  $('migration-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('migration-validate');
    button.disabled = true;
    notice('operator-message', 'Validating and staging migration batch…');
    try {
      const rows = JSON.parse($('migration-json').value);
      if (!Array.isArray(rows)) throw new Error('Transaction data must be a JSON array.');
      const result = await post('/operator/migrations/validate', {
        sourceSystem: $('migration-source-system').value.trim(),
        sourceFileName: $('migration-file-name').value.trim(),
        rows
      });
      $('migration-result').textContent = JSON.stringify(result, null, 2);
      notice('operator-message', `Batch staged: ${result.batch.acceptedCount} accepted, ${result.batch.exceptionCount} exceptions. Cutover remains disabled.`);
      await loadMigrations();
    } catch (error) {
      notice('operator-message', error.message, true);
      $('migration-result').textContent = error.message;
    } finally { button.disabled = false; }
  });
  $('refresh-audit').addEventListener('click', async () => { try { await loadAudit(); } catch (error) { notice('operator-message', error.message, true); } });
  $('audit-search').addEventListener('input', renderAudit);
  $('refresh-migrations').addEventListener('click', async () => {
    try { await loadMigrations(); notice('operator-message', 'Migration batch list refreshed.'); }
    catch (error) { notice('operator-message', error.message, true); }
  });
  $('refresh-operator').addEventListener('click',async()=>{try{await loadAll();notice('operator-message','Console refreshed.');}catch(error){notice('operator-message',error.message,true);}});
  $('refresh-loan-alerts').addEventListener('click',async()=>{try{await loadLoanAlerts();notice('operator-message','Loan alerts refreshed.');}catch(error){notice('operator-message',error.message,true);}});
  $('tier-filter').addEventListener('submit',async event=>{event.preventDefault();try{await loadTiers();}catch(error){notice('operator-message',error.message,true);}});
  (async()=>{try{const data=await api('/auth/operator/me');operator=data.operator;setAuthed(true);applyRoleAccess();$('operator-identity').textContent=`${operator.name} · ${operator.email} · Role: ${operator.role}`;await loadAll();}catch{setAuthed(false);}})();
})();
