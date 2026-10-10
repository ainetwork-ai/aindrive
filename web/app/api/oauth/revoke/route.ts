/** RFC 7009 for registered public clients. Possession of an issued token is
 * required; the request cannot revoke another client's grants or personal keys. */
import {db} from '@/lib/db';
import {hashToken} from '@/lib/mcp-tokens';
import {getClient} from '@/lib/oauth';
import {tryConsume,clientKey} from '@/lib/rate-limit';
const headers={'Cache-Control':'no-store',Pragma:'no-cache','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
export function OPTIONS(){return new Response(null,{status:204,headers});}
export async function POST(req:Request){
 if(!tryConsume({name:'oauth-revoke',key:clientKey(req,'oauth-revoke'),limit:60,windowMs:60000}).ok)
  return Response.json({error:'slow_down'},{status:429,headers});
 const form=new URLSearchParams(await req.text());
 if(form.getAll('client_id').length!==1 || form.getAll('token').length!==1 || !form.get('token'))
  return Response.json({error:'invalid_request'},{status:400,headers});
 const client=getClient(form.get('client_id'));
 if(!client)return Response.json({error:'invalid_client'},{status:401,headers});
 const token=form.get('token')!;
 if(token.length>4096)return Response.json({error:'invalid_request'},{status:400,headers});
 const hash=hashToken(token),now=Date.now();
 db.transaction(()=>{
  // Match the previous refresh token too: disconnect can overlap rotation.
  db.prepare('UPDATE account_tokens SET revoked_at=? WHERE client_id=? AND revoked_at IS NULL AND (token_hash=? OR refresh_hash=? OR prev_refresh_hash=?)')
   .run(now,client.client_id,hash,hash,hash);
  db.prepare("UPDATE mcp_tokens SET revoked_at=? WHERE kind='oauth' AND client_id=? AND revoked_at IS NULL AND (token_hash=? OR refresh_hash=? OR prev_refresh_hash=?)")
   .run(now,client.client_id,hash,hash,hash);
 })();
 // Unknown, already revoked and foreign-client tokens are indistinguishable.
 return new Response(null,{status:200,headers});
}
