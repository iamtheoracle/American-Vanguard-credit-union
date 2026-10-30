(() => {
  'use strict';
  const auth=()=>window.AVCUAuthState||{};
  const request=async(body)=>{
    const response=await fetch('/api/plaid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||'Plaid request failed.');
    return data;
  };
  const verificationLabel=status=>({
    pending_manual_verification:'Verification pending — action required',
    pending_automatic_verification:'Verification pending',
    manually_verified:'Bank account verified',
    automatically_verified:'Bank account verified',
    verification_failed:'Verification failed — reconnect account',
    verification_expired:'Verification expired — reconnect account',
    not_applicable:'Connected'
  }[status]||'Verification status unavailable');
  function mount(){
    const home=document.querySelector('[data-view="home"], #home-view, .home-view');
    if(!home||document.getElementById('plaid-connect-panel')) return;
    const panel=document.createElement('section');
    panel.id='plaid-connect-panel'; panel.className='panel';
    panel.style.cssText='margin:22px 0;padding:22px;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap';
    panel.innerHTML='<div style="min-width:240px;flex:1"><p class="eyebrow">CONNECTED BANKING</p><h2 style="margin:0 0 7px">External bank accounts</h2><p id="plaid-connect-status" class="muted" style="margin:0">Connect a US checking or savings account securely through Plaid.</p><div id="plaid-linked-accounts" style="margin-top:12px"></div></div><button class="primary-button" id="plaid-connect-button" type="button">Connect bank account</button>';
    const anchor=home.querySelector('.balance-hero')||home.firstElementChild;
    if(anchor?.parentNode) anchor.parentNode.insertBefore(panel,anchor.nextSibling); else home.prepend(panel);
    const button=panel.querySelector('#plaid-connect-button'), status=panel.querySelector('#plaid-connect-status'), accounts=panel.querySelector('#plaid-linked-accounts');
    async function refreshItem(itemId,announce=true){
      const data=await request({action:'refresh_accounts',item_id:itemId});
      if(announce) status.textContent='Verification status refreshed from Plaid.';
      await load();
      return data;
    }
    async function verify(itemId,verifyButton){
      verifyButton.disabled=true;
      try{
        const data=await request({action:'create_verification_link_token',item_id:itemId});
        if(!window.Plaid) throw new Error('Plaid Link did not load. Refresh and try again.');
        const handler=window.Plaid.create({
          token:data.link_token,
          onSuccess:async()=>{
            status.textContent='Checking the updated verification status with Plaid…';
            try{await refreshItem(itemId,false);status.textContent='Plaid verification result refreshed.'}
            catch(error){status.textContent=error.message}
          },
          onExit:()=>{verifyButton.disabled=false}
        });
        handler.open();
      }catch(error){status.textContent=error.message;verifyButton.disabled=false}
    }
    async function load(){
      if(!auth().user){status.textContent='Sign in to connect a bank account.';button.disabled=true;return}
      button.disabled=false;
      try{
        const response=await fetch('/api/plaid',{headers:{accept:'application/json'}});
        const data=await response.json();
        if(!response.ok) throw new Error(data.error||'Bank connections are unavailable.');
        accounts.replaceChildren();
        let count=0;
        for(const item of data.items||[]) for(const account of item.accounts||[]){
          count++;
          const row=document.createElement('div');
          row.style.cssText='padding:11px 0;border-top:1px solid #e4eaf0;font-size:12px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap';
          const details=document.createElement('div');
          const name=document.createElement('strong');
          name.textContent=(account.official_name||account.name||'Bank account')+' · •••• '+(account.mask||'----');
          const state=document.createElement('div');
          state.className='muted';state.style.marginTop='4px';
          state.textContent=(account.subtype||account.type||'Account')+' · '+verificationLabel(account.verification_status);
          details.append(name,state);row.append(details);
          if(account.verification_status==='pending_manual_verification'){
            const verifyButton=document.createElement('button');
            verifyButton.type='button';verifyButton.className='secondary-button';verifyButton.textContent='Verify account';
            verifyButton.addEventListener('click',()=>verify(item.item_id,verifyButton));
            row.append(verifyButton);
          }else if(['pending_automatic_verification','verification_expired'].includes(account.verification_status)){
            const refreshButton=document.createElement('button');
            refreshButton.type='button';refreshButton.className='secondary-button';refreshButton.textContent='Refresh status';
            refreshButton.addEventListener('click',async()=>{refreshButton.disabled=true;try{await refreshItem(item.item_id)}catch(error){status.textContent=error.message;refreshButton.disabled=false}});
            row.append(refreshButton);
          }
          accounts.append(row);
        }
        status.textContent=count?'Connected bank accounts. Verification and payment eligibility are tracked separately.':'No external bank accounts are connected yet.';
      }catch(error){status.textContent=error.message||'Could not load connected bank accounts.'}
    }
    button.addEventListener('click',async()=>{
      button.disabled=true;status.textContent='Preparing secure Plaid Link…';
      try{
        const data=await request({action:'create_link_token'});
        if(!window.Plaid) throw new Error('Plaid Link did not load. Refresh and try again.');
        const handler=window.Plaid.create({
          token:data.link_token,
          onSuccess:async(publicToken)=>{
            status.textContent='Securing your bank connection…';
            try{
              const saved=await request({action:'exchange_public_token',public_token:publicToken});
              status.textContent='Connected to '+saved.institution_name+'. Checking account verification status…';
              await load();
            }catch(error){status.textContent=error.message}
            finally{button.disabled=false}
          },
          onExit:()=>{status.textContent='Bank connection cancelled.';button.disabled=false}
        });
        handler.open();
      }catch(error){status.textContent=error.message;button.disabled=false}
    });
    load();
    window.addEventListener('avcu:auth-state-updated',load);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount); else mount();
})();
