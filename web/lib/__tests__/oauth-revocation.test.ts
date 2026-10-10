import {it,expect,beforeAll,afterAll} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
const directory=mkdtempSync(tmpdir()+'/drive-revoke-');
process.env.AINDRIVE_DATA_DIR=directory;
process.env.AINDRIVE_PUBLIC_URL='https://drive.test';
const {db}=await import('../db.js');
const oauth=await import('../oauth');
const account=await import('../account-tokens');
const tokens=await import('../mcp-tokens');
const route=await import('../../app/api/oauth/revoke/route');
let client:string,other:string;
beforeAll(()=>{
 db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)').run('owner','o@test.example','Owner','unused');
 db.prepare('INSERT INTO drives(id,name,owner_id,agent_token_hash,drive_secret) VALUES(?,?,?,?,?)').run('drive','Drive','owner','unused','unused');
 client=oauth.registerClient('Mail',['https://mail.test/callback']).client_id;
 other=oauth.registerClient('Other',['https://other.test/callback']).client_id;
});
afterAll(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
const issue=()=>account.issueAccountTokens({userId:'owner',clientId:client,clientName:'Mail',scopes:['profile']});
const revoke=(token:string,clientId=client)=>route.POST(new Request('https://drive.test/api/oauth/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token,client_id:clientId})}));
it('R-OAUTH-REVOKE-001 revokes account access and refresh using either token',async()=>{
 for(const key of ['access_token','refresh_token'] as const){
  const pair=issue(); expect(account.verifyAccountToken(pair.access_token)).not.toBeNull();
  expect((await revoke(pair[key])).status).toBe(200);
  expect(account.verifyAccountToken(pair.access_token)).toBeNull();
  expect(account.refreshAccountTokens(pair.refresh_token,client)).toBeNull();
 }
});
it('R-OAUTH-REVOKE-001 revokes a grant after an overlapping refresh rotates its tokens',async()=>{
 const pair=issue(),rotated=account.refreshAccountTokens(pair.refresh_token,client)!;
 expect((await revoke(pair.refresh_token)).status).toBe(200);
 expect(account.verifyAccountToken(rotated.access_token)).toBeNull();
 expect(account.refreshAccountTokens(rotated.refresh_token,client)).toBeNull();
});
it('R-OAUTH-REVOKE-001 supports drive-bound grants too',async()=>{
 const pair=tokens.issueOAuthTokens({userId:'owner',driveId:'drive',clientId:client,clientName:'Mail',scope:'read'});
 expect((await revoke(pair.refresh_token)).status).toBe(200);
 expect(tokens.verifyMcpToken(pair.access_token)).toBeNull();
 expect(tokens.refreshOAuthTokens(pair.refresh_token,client)).toBeNull();
});
it('R-OAUTH-REVOKE-002 isolates other clients, grants and personal tokens',async()=>{
 const pair=issue(),untouched=issue();
 expect((await revoke(pair.refresh_token,other)).status).toBe(200);
 expect(account.verifyAccountToken(pair.access_token)).not.toBeNull();
 const pat=tokens.issuePat({userId:'owner',driveId:'drive',name:'Own key',scope:'read',ttlDays:null});
 expect((await revoke(pat.token)).status).toBe(200);
 expect(tokens.verifyMcpToken(pat.token)).not.toBeNull();
 expect((await revoke(pair.access_token)).status).toBe(200);
 expect(account.verifyAccountToken(untouched.access_token)).not.toBeNull();
 expect((await revoke(pair.access_token)).status).toBe(200);
 expect((await revoke('unknown-token')).status).toBe(200);
});
it('R-OAUTH-REVOKE-003 requires registered client and token and advertises no-store',async()=>{
 expect((await revoke('',client)).status).toBe(400);
 expect((await revoke('x','missing')).status).toBe(401);
 const res=await revoke('unknown'); expect(res.headers.get('cache-control')).toBe('no-store');
 expect(oauth.authServerMetadata().revocation_endpoint).toBe('https://drive.test/api/oauth/revoke');
});
it('R-OAUTH-REVOKE-003 rate limits repeated revocation attempts',async()=>{
 let response:Response|undefined;
 for(let i=0;i<65;i++)response=await revoke('unknown');
 expect(response!.status).toBe(429);
 expect(response!.headers.get('cache-control')).toBe('no-store');
});
it('R-OAUTH-REVOKE-002 refresh reuse from another client cannot revoke a rotated grant',()=>{
 const pair=issue(),rotated=account.refreshAccountTokens(pair.refresh_token,client)!;
 expect(account.refreshAccountTokens(pair.refresh_token,other)).toBeNull();
 expect(account.verifyAccountToken(rotated.access_token)).not.toBeNull();
 const drivePair=tokens.issueOAuthTokens({userId:'owner',driveId:'drive',clientId:client,clientName:'Mail',scope:'read'});
 const driveRotated=tokens.refreshOAuthTokens(drivePair.refresh_token,client)!;
 expect(tokens.refreshOAuthTokens(drivePair.refresh_token,other)).toBeNull();
 expect(tokens.verifyMcpToken(driveRotated.access_token)).not.toBeNull();
});
