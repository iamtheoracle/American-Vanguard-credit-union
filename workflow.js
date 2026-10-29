(() => {
'use strict';
const RK='avcu.workflow.v1', MK='avcu.member.v1';
const A={draft:'Share Draft (Checking)',primary:'Primary Share (Savings)',market:'Money Market',holiday:'Holiday Club',business:'Business Operating Account',ira:'Traditional IRA',certificate:'Share Certificate',retirement401k:'401(k) Retirement'};
const T={'internal-transfer':'Internal account transfer','bill-payment':'Bill payment','wire-transfer':'Wire transfer',zelle:'Zelle payment request',fx:'Foreign exchange (FX)',withdrawal:'Withdrawal',ira:'IRA contribution / withdrawal','401k':'401(k) rollover / retirement request','check-deposit':'Check deposit','card-authorization':'Card purchase authorization'};
const external=new Set(['bill-payment','wire-transfer','zelle','fx','withdrawal','ira','401k','check-deposit','card-authorization']);
const routing={'internal-transfer':['Account Services','Account Operator'],'bill-payment':['Payments Operations','Payments Operator'],'wire-transfer':['Payments Operations','Wire Operator'],'zelle':['Payments Operations','Zelle Operator'],'fx':['Treasury Operations','FX Operator'],'withdrawal':['Payments Operations','Withdrawal Operator'],'ira':['Retirement Services','Retirement Administrator'],'401k':['Retirement Services','Retirement Administrator'],'check-deposit':['Deposit Operations','Deposit Operator'],'card-authorization':['Card Services','Card Operator']};
let requests=load(), files=new Map(), zelleVerified=new Map(), fxQuotes=new Map();
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>window.crypto?.randomUUID?.()||('AV-'+Date.now()+'-'+Math.random().toString(16).slice(2,8));
const money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100);
const status=s=>({'pending-approval':'Pending Approval',approved:'Approved','approved-awaiting-provider':'Approved · Awaiting Provider',processing:'Processing · Provider Accepted',settled:'Settled · Provider Confirmed',rejected:'Rejected','needs-information':'Needs Information'}[s]||s);
function load(){try{const x=JSON.parse(localStorage.getItem(RK)||'[]');return Array.isArray(x)?x:[]}catch{return []}}
function save(){try{localStorage.setItem(RK,JSON.stringify(requests));return true}catch{alert('Could not save this request in browser storage.');return false}}
function member(){try{return JSON.parse(localStorage.getItem(MK)||'null')}catch{return null}}
function validAmount(v){let n=Number(v);return Number.isFinite(n)&&n>0&&n<=1000000&&Math.abs(n*100-Math.round(n*100))<1e-7}
function create(d,f){
 const type=String(d.type||''),from=String(d.from||''),to=String(d.to||''),recipient=String(d.recipient||'').trim(),destination=String(d.destination||'').trim(),note=String(d.note||'').trim(),amount=Number(d.amount),currency=String(d.currency||'USD');
 if(!T[type]||!A[from])return {error:'Choose a valid request type and source account.'};
 if(!validAmount(amount))return {error:'Enter a positive amount with no more than two decimal places.'};
 if(!note||note.length>180)return {error:'Enter a purpose or reference (maximum 180 characters).'};
 if(type==='internal-transfer'&&(!A[to]||to===from))return {error:'Choose two different accounts.'};
 if(['bill-payment','wire-transfer','zelle','withdrawal','fx','ira','401k','card-authorization'].includes(type)&&!recipient)return {error:'Enter the recipient, payee, or institution name.'};
 if(['wire-transfer','withdrawal'].includes(type)&&!destination)return {error:'Enter the destination details required for review.'};
 if(type==='fx'){const q=fxQuotes.get(currency+'|'+Math.round(amount*100));if(!q||!Number.isFinite(Date.parse(q.expiresAt))||Date.now()>=Date.parse(q.expiresAt))return {error:'Get a current live FX quote from the connected provider before submitting this request.'};}
 if(type==='check-deposit'&&(!f?.front||!f?.back))return {error:'Capture or select both the front and back of the check.'};
 if(type==='check-deposit'&&[f.front,f.back].some(file=>!String(file.type||'').startsWith('image/')||file.size>12*1024*1024))return {error:'Both check images must be image files smaller than 12 MB each.'};
 const now=new Date().toISOString(),r={id:uid(),type,typeLabel:T[type],from,to:type==='internal-transfer'?to:'',recipient,destination,currency,amountCents:Math.round(amount*100),note,status:'pending-approval',createdAt:now,updatedAt:now,operatorNote:'',providerState:'not-connected',providerLookup:type==='zelle'?(zelleVerified.has(recipient.toLowerCase())?'verified':'unavailable-without-provider'):null,fxQuote:type==='fx'?fxQuotes.get(currency+'|'+Math.round(amount*100)):null,assignedTeam:routing[type][0],assignedRole:routing[type][1],checkImages:type==='check-deposit'?{frontName:f.front.name,backName:f.back.name}:null,audit:[{at:now,actor:'Member',action:'Submitted for approval'}]};
 r.automatedReview=window.AVCUReviewAssistant?.assessLocally?.(r,requests)||{mode:'local-rules',flags:['Automated review assistant not configured.'],advisoryOnly:true};
 requests.unshift(r);requests=requests.slice(0,500);if(!save()){requests.shift();return {error:'Request could not be saved.'}}if(f?.front&&f?.back)files.set(r.id,f);
 if(window.AVCUReviewAssistant?.assess){window.AVCUReviewAssistant.assess(r,requests.filter(item=>item.id!==r.id)).then(result=>{r.automatedReview=result;save();render()}).catch(()=>{})}
 return {request:r};
}
function postTransfer(r){
 const s=member();if(!s?.balances||typeof s.balances!=='object'||!Array.isArray(s.transactions))return 'Local account records are unavailable; connect the core account service before posting.';
 const processed=Array.isArray(s.processedTransferRequests)?s.processedTransferRequests:[];
 if(processed.includes(r.id))return 'This request was already applied to the local ledger. Reconcile the request record before retrying; no second transfer was posted.';
 const fromBalance=s.balances[r.from],toBalance=s.balances[r.to];
 if(!Number.isSafeInteger(r.amountCents)||r.amountCents<=0||!Number.isSafeInteger(fromBalance)||!Number.isSafeInteger(toBalance)||fromBalance<r.amountCents||r.from===r.to)return 'Approval blocked: valid distinct accounts and sufficient available funds are required.';
 s.balances[r.from]=fromBalance-r.amountCents;s.balances[r.to]=toBalance+r.amountCents;s.processedTransferRequests=[...processed,r.id].slice(-1000);const now=new Date().toISOString();
 s.transactions.unshift({id:uid(),account:r.from,title:'Approved account transfer',amount:-r.amountCents,date:now,detail:'Approved internal transfer'},{id:uid(),account:r.to,title:'Transfer received',amount:r.amountCents,date:now,detail:'Approved internal transfer'});
 s.transactions=s.transactions.slice(0,100);try{localStorage.setItem(MK,JSON.stringify(s))}catch{return 'Approval blocked: account records could not be saved. No transfer was posted.'}window.dispatchEvent(new CustomEvent('avcu:member-state-updated'));return '';
}
function card(r,operator){
 const recipient=r.type==='internal-transfer'?A[r.to]:(r.recipient||r.destination||r.currency||'Provider required');
 const check=r.type==='check-deposit'?'<div class="workflow-meta"><span>Front: '+esc(r.checkImages?.frontName||'Missing')+'</span><span>Back: '+esc(r.checkImages?.backName||'Missing')+'</span>'+(files.has(r.id)?'<button class="secondary-button" data-preview="'+esc(r.id)+'" type="button">Review check images</button>':'<span>Images are not retained after refresh. Secure document storage is required.</span>')+'</div>':'';
 const note=r.operatorNote?'<p class="workflow-note"><b>Review note:</b> '+esc(r.operatorNote)+'</p>':'';
 const warn=r.type==='zelle'?'<p class="workflow-warning">Live Zelle recipient verification is unavailable without the authorized provider. This request is not verified or sent.</p>':r.status==='approved-awaiting-provider'?'<p class="workflow-warning">Approved for processing; no external funds have been sent or settled. Provider confirmation is required.</p>':'';
 const flags=(r.automatedReview?.flags||[]).map(flag=>'<li>'+esc(flag)+'</li>').join('');
 const reviewBlock='<details class="workflow-audit"><summary>Automated review checks · advisory only</summary><p>Mode: '+esc(r.automatedReview?.mode||'local-rules')+'</p><ul>'+flags+'</ul></details>';
 const actions=operator&&r.status==='pending-approval'?'<div class="workflow-actions"><label>Review note <input data-note="'+esc(r.id)+'" maxlength="240" placeholder="Reason or checks completed"></label><button class="primary-button" data-review="approve" data-id="'+esc(r.id)+'" type="button">Approve</button><button class="secondary-button" data-review="needs-information" data-id="'+esc(r.id)+'" type="button">Request information</button><button class="secondary-button" data-review="reject" data-id="'+esc(r.id)+'" type="button">Reject</button></div>':'';
 const audit=(r.audit||[]).slice(-3).map(x=>'<li>'+esc(new Date(x.at).toLocaleString())+' · '+esc(x.actor)+': '+esc(x.action)+'</li>').join('');
 return '<article class="workflow-request"><div class="workflow-request-top"><div><strong>'+esc(r.typeLabel)+'</strong><small>Reference '+esc(r.id)+'</small></div><span class="workflow-status">'+esc(status(r.status))+'</span></div><div class="workflow-meta"><span><b>Amount</b> '+esc(money(r.amountCents))+(r.currency!=='USD'?' · To '+esc(r.currency):'')+'</span><span><b>From</b> '+esc(A[r.from]||r.from)+'</span><span><b>To / recipient</b> '+esc(recipient)+'</span><span><b>Submitted</b> '+esc(new Date(r.createdAt).toLocaleString())+'</span><span><b>Purpose</b> '+esc(r.note)+'</span><span><b>Routed to</b> '+esc(r.assignedTeam||'Operations')+' · '+esc(r.assignedRole||'Authorized reviewer')+'</span></div>'+warn+note+check+reviewBlock+'<details class="workflow-audit"><summary>Request audit history</summary><ul>'+audit+'</ul></details>'+actions+'</article>';
}
function render(){
 const m=$('workflow-member-queue'),o=$('workflow-operator-queue');if(!m||!o)return;
 m.innerHTML=requests.length?requests.map(r=>card(r,false)).join(''):'<p class="empty-state">No requests yet. Submit a payment or service request to get started.</p>';
 const p=requests.filter(r=>['pending-approval','needs-information'].includes(r.status));
 o.innerHTML=p.length?p.map(r=>card(r,true)).join(''):'<p class="empty-state">No requests awaiting review.</p>';
 if($('workflow-pending-count'))$('workflow-pending-count').textContent=p.length+' pending';
}
function fields(){
 const t=$('workflow-type')?.value;if(!t)return;const internal=t==='internal-transfer',check=t==='check-deposit',isZelle=t==='zelle',isFx=t==='fx';
 $('workflow-to-wrap')?.classList.toggle('hidden',!internal);$('workflow-recipient-wrap')?.classList.toggle('hidden',internal||check);
 $('workflow-destination-wrap')?.classList.toggle('hidden',!['wire-transfer','withdrawal'].includes(t));$('workflow-currency-wrap')?.classList.toggle('hidden',t!=='fx');$('workflow-check-wrap')?.classList.toggle('hidden',!check);$('zelle-lookup')?.classList.toggle('hidden',!isZelle);$('zelle-lookup-note')?.classList.toggle('hidden',!isZelle);$('zelle-lookup-result')?.classList.add('hidden');$('fx-quote')?.classList.toggle('hidden',!isFx);$('fx-quote-result')?.classList.toggle('hidden',!isFx);
 if($('workflow-recipient'))$('workflow-recipient').required=!internal&&!check;
 if($('workflow-destination'))$('workflow-destination').required=['wire-transfer','withdrawal'].includes(t);
 if($('workflow-to'))$('workflow-to').required=internal;
}
async function getFxQuote(){
 const amount=Number($('workflow-amount')?.value),currency=String($('workflow-currency')?.value||'USD'),out=$('fx-quote-result');
 if(!validAmount(amount)){alert('Enter a valid amount before requesting an FX quote.');return}
 if(out){out.classList.remove('hidden');out.textContent='Requesting a live quote…'}
 if(!window.AVCUProviders?.supports?.('getFxQuote')){if(out)out.textContent='Live FX quotes are unavailable because the authorized FX provider is not connected. No rate is estimated.';return}
 try{
  const q=await window.AVCUProviders.getFxQuote({amount,fromCurrency:'USD',toCurrency:currency});
  if(!q||!Number.isFinite(Number(q.rate))||Number(q.rate)<=0||!q.quoteId){if(out)out.textContent=q?.message||'The provider did not return a valid, identified quote.';return}
  const key=currency+'|'+Math.round(amount*100),quote={quoteId:String(q.quoteId),rate:Number(q.rate),expiresAt:q.expiresAt||new Date(Date.now()+300000).toISOString()};
  fxQuotes.set(key,quote);
  if(out)out.textContent='Provider quote: 1 USD = '+quote.rate+' '+currency+'. Estimated receive amount: '+(amount*quote.rate).toFixed(2)+' '+currency+'. Quote reference: '+quote.quoteId+'. Expires: '+new Date(quote.expiresAt).toLocaleString()+'.';
 }catch{if(out)out.textContent='FX quote failed. No exchange rate was applied.'}
}
async function lookupZelle(){
 const name=String($('workflow-recipient')?.value||'').trim(),out=$('zelle-lookup-result');
 if(!name){alert('Enter the recipient name before checking.');return}
 if(out){out.classList.remove('hidden');out.textContent='Checking recipient directory…'}
 if(!window.AVCUProviders?.supports?.('lookupZelleRecipient')){if(out)out.textContent='Recipient verification is unavailable: the authorized Zelle provider is not connected. This name is not verified.';return}
 try{
  const result=await window.AVCUProviders.lookupZelleRecipient(name);
  if(result?.verified===true){zelleVerified.set(name.toLowerCase(),result);if(out)out.textContent='Recipient verified by the connected provider. Review the returned recipient details before submitting.'}
  else{zelleVerified.delete(name.toLowerCase());if(out)out.textContent=result?.message||'No verified recipient match was returned.'}
 }catch{zelleVerified.delete(name.toLowerCase());if(out)out.textContent='Recipient verification failed. No payment was sent.'}
}
function dispatchProvider(r){
 if(!window.AVCUProviders?.isConfigured?.())return;
 window.AVCUProviders.initiatePayment(r).then(result=>{
  if(result?.status==='accepted'){r.status='processing';r.providerState='accepted';r.audit.push({at:new Date().toISOString(),actor:'Payment provider',action:'Accepted for processing; settlement not confirmed'});}
  else{r.providerState=result?.code||'provider-error';r.operatorNote=(r.operatorNote+' Provider response: '+(result?.message||'Acceptance was not confirmed.')).trim();r.audit.push({at:new Date().toISOString(),actor:'Payment provider',action:'Provider did not confirm acceptance'});}
  r.updatedAt=new Date().toISOString();save();render();
 }).catch(()=>{r.providerState='provider-error';r.updatedAt=new Date().toISOString();r.audit.push({at:r.updatedAt,actor:'Payment provider',action:'Provider request failed'});save();render()});
}
function preview(inputId,targetId,label){
 const file=$(inputId)?.files?.[0],target=$(targetId);if(!target)return;if(!file){target.textContent=label+' image not selected.';return}
 if(!file.type.startsWith('image/')||file.size>12*1024*1024){target.textContent='Choose an image smaller than 12 MB.';return}
 const prior=target.querySelector('img');if(prior?.src?.startsWith('blob:'))URL.revokeObjectURL(prior.src);const url=URL.createObjectURL(file);
 target.innerHTML='<img src="'+url+'" alt="'+label+' of check preview"><span>'+esc(file.name)+' · '+(file.size/1048576).toFixed(1)+' MB</span>';
}
function submit(e){
 const form=e.target;if(!['workflow-form','transfer-form','deposit-form'].includes(form?.id))return;
 e.preventDefault();e.stopImmediatePropagation();let d,f=null;
 if(form.id==='workflow-form'){d=Object.fromEntries(new FormData(form).entries());if(d.type==='check-deposit')f={front:$('check-front')?.files?.[0],back:$('check-back')?.files?.[0]}}
 else if(form.id==='transfer-form'){const x=Object.fromEntries(new FormData(form).entries());d={...x,from:x.kind==='bill'?'draft':x.from,type:x.kind==='bill'?'bill-payment':'internal-transfer',recipient:x.payee||'',note:x.memo||x.payee||'Account transfer request'}}
 else {const x=Object.fromEntries(new FormData(form).entries());d={...x,type:'check-deposit',from:x.account,note:x.description||'Check deposit request'};f={front:$('legacy-check-front')?.files?.[0],back:$('legacy-check-back')?.files?.[0]}}
 const out=create(d,f);if(out.error){alert(out.error);return}render();
 if(form.id==='workflow-form'){form.reset();fields();['check-front-preview','check-back-preview'].forEach((k,i)=>{if($(k))$(k).textContent=(i?'Back':'Front')+' image not selected.'})}else form.reset();
 const msg='Request '+out.request.id+' submitted. Status: Pending Approval.';if($('live-announcer'))$('live-announcer').textContent=msg;if($('toast-region'))$('toast-region').textContent=msg;
 if(typeof window.setAVCUView==='function')window.setAVCUView('operations');
}
function review(e){
 const b=e.target.closest('[data-review]');if(b){const r=requests.find(x=>x.id===b.dataset.id);if(!r||r.status!=='pending-approval')return;const note=document.querySelector('[data-note="'+r.id+'"]')?.value?.trim()||'';
 if(b.dataset.review!=='approve'&&note.length<4){alert('Add a review note of at least four characters.');return}
 if(r.type==='check-deposit'&&!files.has(r.id)){alert('Check images are unavailable for review. Reattach both images or keep the request pending until secure document storage is connected.');return}
 if(b.dataset.review==='approve'&&r.type==='internal-transfer'){const err=postTransfer(r);if(err){alert(err);return}r.status='approved';r.operatorNote=note||'Approved after local review; internal ledger updated.'}
 else if(b.dataset.review==='approve'){if(r.type==='zelle'&&r.providerLookup!=='verified'){alert('Approval blocked: verify the recipient with the connected Zelle provider first.');return}r.status=external.has(r.type)?'approved-awaiting-provider':'approved';r.operatorNote=note||'Approved for next processing step. External settlement requires provider confirmation.'}
 else if(b.dataset.review==='reject'){r.status='rejected';r.operatorNote=note}else{r.status='needs-information';r.operatorNote=note}
 r.decisionBy='Local operator workspace';r.updatedAt=new Date().toISOString();r.audit.push({at:r.updatedAt,actor:'Operator workspace',action:status(r.status)+(note?': '+note:'')});save();render();if(r.status==='approved-awaiting-provider')dispatchProvider(r);if($('live-announcer'))$('live-announcer').textContent='Request '+r.id+': '+status(r.status);return}
 const p=e.target.closest('[data-preview]');if(p){const f=files.get(p.dataset.preview);if(!f)return alert('Images are not available in this session.');const urls=[URL.createObjectURL(f.front),URL.createObjectURL(f.back)];const w=window.open('','_blank');if(!w){urls.forEach(URL.revokeObjectURL);return alert('Allow the image review window and retry.')}w.document.write('<title>Check review</title><h1>Front of check</h1><img style="max-width:95%" src="'+urls[0]+'"><h1>Back of check</h1><img style="max-width:95%" src="'+urls[1]+'"><p>Session-only images.</p>');w.document.close()}
}
function init(){
 document.addEventListener('click',e=>{const b=e.target.closest('#simulate-purchase');if(!b)return;e.preventDefault();e.stopImmediatePropagation();const amount=$('purchase-amount')?.value,merchant=String($('purchase-merchant')?.value||'').trim();let s=null;try{s=JSON.parse(localStorage.getItem(MK)||'null')}catch{}if(s?.frozen){alert('This card is frozen. The authorization request was not submitted.');return}const out=create({type:'card-authorization',from:'draft',recipient:merchant,amount,note:'Card purchase authorization request for '+merchant});if(out.error){alert(out.error);return}render();if($('live-announcer'))$('live-announcer').textContent='Card authorization request submitted for approval.';if($('toast-region'))$('toast-region').textContent='Purchase authorization request submitted for approval. No merchant authorization has occurred.';window.setAVCUView?.('operations')},true);
 ['workflow-form','transfer-form','deposit-form'].forEach(k=>$(k)?.addEventListener('submit',submit,true));
 $('workflow-type')?.addEventListener('change',fields);$('zelle-lookup')?.addEventListener('click',lookupZelle);$('fx-quote')?.addEventListener('click',getFxQuote);$('workflow-amount')?.addEventListener('input',()=>{if($('fx-quote-result'))$('fx-quote-result').textContent='Amount changed. Request a fresh FX quote.'});$('workflow-currency')?.addEventListener('change',()=>{if($('fx-quote-result'))$('fx-quote-result').textContent='Currency changed. Request a fresh FX quote.'});$('check-front')?.addEventListener('change',()=>preview('check-front','check-front-preview','Front'));$('check-back')?.addEventListener('change',()=>preview('check-back','check-back-preview','Back'));
 $('workflow-member-queue')?.addEventListener('click',review);$('workflow-operator-queue')?.addEventListener('click',review);fields();render();window.renderWorkflowWorkspace=render;
 window.setAVCUView=v=>document.querySelector('[data-nav="'+v+'"]')?.click();window.addEventListener('avcu:member-state-updated',()=>window.renderAll?.());window.addEventListener('avcu:reset-workflow',()=>{requests=[];files.clear();zelleVerified.clear();fxQuotes.clear();save();render()});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();