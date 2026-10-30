(() => {
  'use strict';
  const auth=()=>window.AVCUAuthState||{};
  const request=async (body)=>{
    const response=await fetch('/api/plaid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||'Plaid request failed.');
    return data;
  };
  function mount(){
    const home=document.querySelector('[data-view="home"], #home-view, .home-view');
    if(!home||document.getElementById('plaid-connect-panel')) return;
    const panel=document.createElement('section');
    panel.id='plaid-connect-panel'; panel.className='panel';
    panel.style.cssText='margin:22px 0;padding:22px;display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap';
    panel.innerHTML='<div><p class="eyebrow">CONNECTED BANKING</p><h2 style="margin:0 0 7px">Connect an external bank</h2><p id="plaid-connect-status" class="muted" style="margin:0">Securely link a US checking or savings account through Plaid.</p><div id="plaid-linked-accounts" style="margin-top:12px"></div></div><button class="primary-button" id="plaid-connect-button" type="button">Connect bank account</button>';
    const anchor=home.querySelector('.balance-hero')||home.firstElementChild;
    if(anchor?.parentNode) anchor.parentNode.insertBefore(panel,anchor.nextSibling); else home.prepend(panel);
    const button=panel.querySelector('#plaid-connect-button'), status=panel.querySelector('#plaid-connect-status'), accounts=panel.querySelector('#plaid-linked-accounts');
    async function load(){
      if(!auth().user){status.textContent='Sign in to connect a bank account.';button.disabled=true;return;}
      try{
        const response=await fetch('/api/plaid',{headers:{'accept':'application/json'}});
        const data=await response.json();
        if(response.ok){
          accounts.replaceChildren();
          for(const item of data.items||[]) for(const account of item.accounts||[]){
            const row=document.createElement('div');row.style.cssText='padding:9px 0;border-top:1px solid #e4eaf0;font-size:12px';
            row.textContent=(account.official_name||account.name)+' · '+(account.subtype||account.type)+' · •••• '+(account.mask||'----');
            accounts.append(row);
          }
          if((data.items||[]).length) status.textContent='Bank connection saved securely. Account balances are not supplied by this connection.';
        }else status.textContent=data.error||'Bank connections are unavailable.';
      }catch{status.textContent='Could not load connected bank accounts.'}
    }
    button.addEventListener('click',async()=>{
      button.disabled=true; status.textContent='Preparing secure Plaid Link…';
      try{
        const data=await request({action:'create_link_token'});
        if(!window.Plaid) throw new Error('Plaid Link did not load. Refresh and try again.');
        const handler=window.Plaid.create({
          token:data.link_token,
          onSuccess:async(publicToken)=>{
            status.textContent='Securing your bank connection…';
            try{
              const saved=await request({action:'exchange_public_token',public_token:publicToken});
              status.textContent='Connected to '+saved.institution_name+'. Your account details are protected.';
              await load();
            }catch(error){status.textContent=error.message}
            finally{button.disabled=false}
          },
          onExit:(err)=>{status.textContent=err?.display_message||'Bank connection cancelled.';button.disabled=false}
        });
        handler.open();
      }catch(error){status.textContent=error.message;button.disabled=false}
    });
    load();
    window.addEventListener('avcu:auth-state-updated',load);
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mount); else mount();
})();
