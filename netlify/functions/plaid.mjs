import { getUser, verifyRequestOrigin } from '@netlify/identity';
import { getDatabase } from '@netlify/database';
import { createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';

const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store, private','x-content-type-options':'nosniff'}});
const env=()=>({
  clientId:process.env.PLAID_CLIENT_ID,
  secret:process.env.PLAID_SECRET,
  env:process.env.PLAID_ENV==='production'?'production':'sandbox',
  key:process.env.PLAID_TOKEN_ENCRYPTION_KEY
});
function cryptoKey(value){
  if(!value) throw new Error('PLAID_TOKEN_ENCRYPTION_KEY is not configured');
  const key=Buffer.from(value,'base64');
  if(key.length!==32) throw new Error('PLAID_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return key;
}
function encrypt(value,key){
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.');
}
function decrypt(value,key){
  const [iv,tag,data]=String(value).split('.');
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));
  decipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8');
}
async function plaid(path,body){
  const c=env();
  if(!c.clientId||!c.secret) throw new Error('Plaid server credentials are not configured');
  const response=await fetch('https://'+c.env+'.plaid.com'+path,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({...body,client_id:c.clientId,secret:c.secret})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const error=new Error(data.error_message||'Plaid request failed');
    error.status=response.status; error.code=data.error_code||'PLAID_ERROR'; error.requestId=data.request_id;
    throw error;
  }
  return data;
}
function safeError(error){
  if(error.code==='NO_LIABILITY_ACCOUNTS') return {error:'The connected bank Item has no eligible liability accounts for the requested product. For bank-account linking, use Auth with eligible checking or savings accounts; do not request Liabilities unless credit or loan accounts are needed.',code:error.code,request_id:error.requestId};
  return {error:error.status===400?'Plaid rejected the request. Check the Link configuration and Plaid Dashboard product access.':'Plaid is temporarily unavailable or not configured.',code:error.code||'PLAID_UNAVAILABLE',request_id:error.requestId};
}
export async function handlePlaidRequest(request,deps={}){
  const getUserFn=deps.getUser||getUser, getDatabaseFn=deps.getDatabase||getDatabase;
  if(request.method!=='GET'&&request.method!=='POST') return respond({error:'Method not allowed.'},405);
  try { if(request.method==='POST') (deps.verifyRequestOrigin||verifyRequestOrigin)(request); }
  catch { return respond({error:'Cross-origin request blocked.'},403); }
  let user;
  try { user=await getUserFn(); } catch { return respond({error:'Identity is unavailable.'},503); }
  if(!user||!Array.isArray(user.roles)||!user.roles.some(role=>['member','operator','admin'].includes(role))) return respond({error:'Sign in with an authorized AVCU account.'},401);
  const c=env();
  if(!c.clientId||!c.secret) return respond({configured:false,error:'Plaid is not configured for this deployment. Add server-side Plaid credentials.'},503);
  let db;
  try { db=getDatabaseFn(); } catch { return respond({error:'The secure database is unavailable.'},503); }
  try {
    if(request.method==='GET'){
      const rows=await db.sql`SELECT item_id,institution_name,accounts,created_at FROM avcu_plaid_items WHERE member_id=${user.id} ORDER BY created_at DESC`;
      return respond({items:rows.map(row=>({item_id:row.item_id,institution_name:row.institution_name,accounts:row.accounts||[],created_at:row.created_at,environment:c.env}))});
    }
    const body=await request.json().catch(()=>null);
    if(!body||typeof body!=='object') return respond({error:'A valid JSON request is required.'},400);
    if(body.action==='create_link_token'){
      const link=await plaid('/link/token/create',{
        user:{client_user_id:String(user.id)},
        client_name:'AVCU',
        products:['auth'],
        country_codes:['US'],
        language:'en',
        account_filters:{depository:{account_subtypes:['checking','savings']}}
      });
      return respond({link_token:link.link_token,expiration:link.expiration});
    }
    if(body.action==='exchange_public_token'){
      const publicToken=String(body.public_token||'');
      if(!/^public-(sandbox|production)-[a-f0-9-]+$/i.test(publicToken)) return respond({error:'A valid Plaid public token is required.'},400);
      const exchanged=await plaid('/item/public_token/exchange',{public_token:publicToken});
      const item=await plaid('/item/get',{access_token:exchanged.access_token});
      const auth=await plaid('/auth/get',{access_token:exchanged.access_token});
      const key=cryptoKey(c.key);
      const accounts=(auth.accounts||[]).map(account=>({
        account_id:account.account_id,
        name:account.name,
        official_name:account.official_name||null,
        mask:account.mask||null,
        type:account.type,
        subtype:account.subtype
      }));
      await db.sql`INSERT INTO avcu_plaid_items (member_id,item_id,institution_id,institution_name,access_token_ciphertext,accounts,environment)
        VALUES (${user.id},${exchanged.item_id},${item.item.institution_id||null},${item.item.institution_name||'Connected institution'},${encrypt(exchanged.access_token,key)},${JSON.stringify(accounts)}::jsonb,${c.env})
        ON CONFLICT (member_id,item_id) DO UPDATE SET institution_name=EXCLUDED.institution_name,access_token_ciphertext=EXCLUDED.access_token_ciphertext,accounts=EXCLUDED.accounts,updated_at=now()`;
      return respond({connected:true,institution_name:item.item.institution_name||'Connected institution',accounts});
    }
    return respond({error:'Unsupported Plaid action.'},400);
  } catch(error) {
    return respond(safeError(error),error.status&&error.status>=400&&error.status<500?400:503);
  }
}
export default request=>handlePlaidRequest(request);
export const config={path:'/api/plaid',method:['GET','POST']};
