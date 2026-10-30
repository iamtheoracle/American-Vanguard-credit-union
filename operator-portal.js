(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let operator = null;
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
    $('approval-list').innerHTML=data.approvals?.length? `<table><thead><tr><th>Type</th><th>Member / reference</th><th>Amount</th><th>Status</th><th>Required role</th><th>Actions</th></tr></thead><tbody>${data.approvals.map(a=>`<tr><td>${esc(a.itemType)}</td><td><strong>${esc(a.memberName||a.reference||a.id)}</strong><small>${esc(a.memberEmail||a.transactionType||'')}</small></td><td>${a.amountCents==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(a.amountCents)/100)}</td><td><span class="status-pill">${esc(a.status.replaceAll('_',' '))}</span></td><td>${esc(a.requiredRole)}</td><td class="action-cell">${['pending','escalated'].includes(a.status)?`<button class="mini-action" data-approval="${esc(a.id)}" data-action="approve">Approve</button><button class="mini-action danger-action" data-approval="${esc(a.id)}" data-action="reject">Reject</button><button class="mini-action" data-approval="${esc(a.id)}" data-action="escalate">Escalate</button>`:'—'}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No approvals in this queue.</p>';
    $('approval-list').querySelectorAll('[data-approval]').forEach(button=>button.addEventListener('click',async()=>{
      const action=button.dataset.action;
      let reason='';
      if(action==='reject'||action==='escalate'){reason=window.prompt(action==='reject'?'Enter the reason for rejection:':'Enter why this item needs escalation:')||'';if(!reason.trim())return;}
      try{await api(`/operator/approvals/${encodeURIComponent(button.dataset.approval)}/decide`,{method:'POST',body:JSON.stringify({action,reason})});notice('operator-message',`Approval ${action} request processed.`);await loadAll();}
      catch(error){notice('operator-message',error.message,true);}
    }));
  }
  const money = cents => {
    if(cents==null||cents==='')return '—';
    const raw=String(cents);const negative=raw.startsWith('-');const digits=negative?raw.slice(1):raw;
    if(!/^\d+$/.test(digits))return '—';
    const value=BigInt(digits);const dollars=value/100n;const fraction=String(value%100n).padStart(2,'0');
    return (negative?'-':'')+'$'+dollars.toLocaleString('en-US')+'.'+fraction;
  };
  async function loadMemberHistory(event){
    event?.preventDefault();
    const memberId=$('history-member-id').value.trim();
    if(!memberId)return;
    const params=new URLSearchParams({from:$('history-from').value,to:$('history-to').value});
    $('member-history').innerHTML='<p class="muted">Loading recorded account history…</p>';
    try{
      const data=await api('/operator/members/'+encodeURIComponent(memberId)+'/account-history?'+params.toString());
      const m=data.member;
      const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'local time';
      const date=value=>value?esc(new Intl.DateTimeFormat('en-US',{weekday:'short',year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(value))+' · '+zone):'Not recorded';
      const table=(headers,rows)=>rows.length?'<div class="table-wrap"><table><thead><tr>'+headers.map(esc).map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>':'<p class="muted">No matching recorded entries.</p>';
      const accounts=data.accounts.map(a=>'<tr><td><strong>'+esc(a.name)+'</strong><small>'+esc(a.kind)+' · •••• '+esc(a.suffix)+'</small></td><td>'+esc(a.status)+'</td><td>'+date(a.openedAt)+'</td><td>'+money(a.currentBalanceCents)+'</td></tr>');
      const tx=data.transactions.map(t=>'<tr><td>'+date(t.initiatedAt)+'</td><td><strong>'+esc(t.type)+'</strong><small>'+esc(t.reference)+'</small></td><td>'+esc(t.fromAccount||'—')+' → '+esc(t.toAccount||t.payee||'—')+'</td><td>'+esc(String(t.status).replaceAll('_',' '))+'</td><td>'+money(t.amountCents)+'</td></tr>');
      const ledger=data.ledgerEntries.map(e=>'<tr><td>'+date(e.recordedAt)+'</td><td>'+esc(e.accountName)+'</td><td>'+esc(e.direction)+'</td><td>'+money(e.amountCents)+'</td><td>'+money(e.balanceAfterCents)+'</td><td>'+esc(e.reference||e.memo||'—')+'</td></tr>');
      const periodRows=rows=>rows.map(p=>'<tr><td>'+date(p.period)+'</td><td>'+esc(p.transactionCount)+'</td><td>'+money(p.grossAmountCents)+'</td></tr>');
      const last=data.lastRecordedActivity||{};
      $('member-history').innerHTML='<h3>'+esc(m.fullName)+'</h3><p class="muted">'+esc(m.memberNumber)+' · '+esc(m.email)+' · '+esc(m.membershipStatus)+' · Member since '+date(m.memberSince)+'</p>'+
        '<h3>Accounts and current recorded balances</h3>'+table(['Account','Status','Opened','Current recorded balance'],accounts)+
        '<h3>Last recorded activity</h3><p>Last transaction: '+date(last.lastTransactionAt)+' · Last ledger entry: '+date(last.lastLedgerActivityAt)+' · Last outgoing transaction initiation: '+date(last.lastOutgoingInitiatedAt)+'</p>'+
        '<h3>Daily Account Activity &mdash; '+esc(data.range.from)+' through '+esc(data.range.to)+'</h3><p class="muted small">Transaction timestamps are displayed in '+esc(zone)+'. Initiation time is not proof of settlement or posting.</p>'+table(['Initiated date / time','Transaction type / reference','Account route','Status','Amount'],tx)+
        '<h3>Ledger entries and balance-after records</h3>'+table(['Recorded','Account','Direction','Amount','Balance after','Reference / memo'],ledger)+
        '<h3>Weekly Account Summary</h3><p class="muted small">Gross initiated transaction volume; not net posted ledger activity.</p>'+table(['Week commencing','Transaction count','Gross transaction amount'],periodRows(data.weekly))+
        '<h3>Monthly Account Statement Summary</h3><p class="muted small">Gross initiated transaction volume; not net posted ledger activity.</p>'+table(['Statement month','Transaction count','Gross transaction amount'],periodRows(data.monthly))+
        '<p class="muted small">'+data.limitations.map(esc).join(' ')+'</p>';
    }catch(error){$('member-history').innerHTML='<p class="error">'+esc(error.message)+'</p>';}
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
  async function loadEmailLog(){
    try{
      const data=await api('/operator/email-deliveries?limit=50');
      $('gmail-config-status').textContent=data.gmailConfigured?'Gmail configured':'Gmail not configured';
      $('gmail-config-status').classList.toggle('good-tag',data.gmailConfigured);
      $('email-log').innerHTML=data.deliveries?.length?`<table><thead><tr><th>Time</th><th>Recipient</th><th>Event</th><th>Subject</th><th>Status</th><th>Error</th></tr></thead><tbody>${data.deliveries.map(e=>`<tr><td>${esc(new Date(e.createdAt).toLocaleString())}</td><td>${esc(e.recipient)}</td><td>${esc(e.eventType)}</td><td>${esc(e.subject)}</td><td><span class="status-pill">${esc(e.status)}</span></td><td>${esc(e.errorCode||'—')}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No email delivery records yet.</p>';
    }catch(error){$('gmail-config-status').textContent='Not available for this role';$('email-log').innerHTML=`<p class="muted">${esc(error.message)}</p>`;}
  }
  async function loadAll(){
    const queue=await api('/operator/queue');
    $('queue-approvals').textContent=Number(queue.approvals?.pending||0)+Number(queue.approvals?.escalated||0);
    $('queue-members').textContent=queue.membershipPending??0;
    $('queue-cases').textContent=queue.cases?.open??0;
    await loadApprovals();
    await loadTiers();
    await loadEmailLog();
  }
  $('operator-login-form').addEventListener('submit',async event=>{
    event.preventDefault();notice('operator-auth-message','Signing in…');
    try{const data=await post('/operator/login',{email:$('operator-email').value,password:$('operator-password').value});operator=data.operator;setAuthed(true);$('operator-identity').textContent=`${operator.name} · ${operator.email} · Role: ${operator.role}`;await loadAll();notice('operator-message','Signed in. Permissions are enforced by the API.');}
    catch(error){notice('operator-auth-message',error.message,true);}
  });
  $('operator-logout').addEventListener('click',async()=>{try{await post('/operator/logout',{});}catch{}operator=null;setAuthed(false);});
  $('refresh-operator').addEventListener('click',async()=>{try{await loadAll();notice('operator-message','Console refreshed.');}catch(error){notice('operator-message',error.message,true);}});
  $('history-form').addEventListener('submit',loadMemberHistory);
  $('tier-filter').addEventListener('submit',async event=>{event.preventDefault();try{await loadTiers();}catch(error){notice('operator-message',error.message,true);}});
  (async()=>{try{const data=await api('/auth/operator/me');operator=data.operator;setAuthed(true);$('operator-identity').textContent=`${operator.name} · ${operator.email} · Role: ${operator.role}`;await loadAll();}catch{setAuthed(false);}})();
})();