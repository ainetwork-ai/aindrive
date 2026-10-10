import {it,expect,afterAll} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
const directory=mkdtempSync(tmpdir()+'/drive-org-recipients-');
process.env.AINDRIVE_DATA_DIR=directory;
process.env.AINDRIVE_PUBLIC_URL='https://drive.test';
process.env.AINDRIVE_SSO_ISSUER='https://sso.test';
process.env.AINDRIVE_SSO_CLIENT_ID='drive-client';
const {db}=await import('../db.js');
const store=await import('../sso/store.js');
const sharing=await import('../drive-sharing');
const invites=await import('../invites.js');
const issuer='https://sso.test';
db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)').run('owner','owner@test.example','Owner','unused');
db.prepare('INSERT INTO drives(id,name,owner_id,agent_token_hash,drive_secret) VALUES(?,?,?,?,?)').run('drive','Drive','owner','unused','unused');
afterAll(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
function jit(sub:string){return store.resolveOrCreateUserForSubject({issuer,subject:sub,name:sub,email:sub+'@personal.test',emailVerified:true}).userId;}
function state(sub:string,email:string,version=1,status:'active'|'suspended'|'deprovisioned'='active',orgId='org'){
 return {schema:'ain-sso.adapter.v1' as const,sub,org:{id:orgId,slug:orgId,name:orgId},version,status,profile:{name:sub,email:sub+'@personal.test',workEmail:email},appRole:'member',groups:[],legacyUserId:null,ownershipTransferTo:null,issuedAt:new Date().toISOString()};
}
const grant=(email:string)=>sharing.grantByEmail({driveId:'drive',actorId:'owner',email,path:'plans/file.txt',role:'viewer'});
const access=(email:string,path='plans/file.txt')=>sharing.accessForEmails('drive',path,[email])[0].access;
it('R-RECIPIENT-001 JIT before provisioning shares to canonical account without rewriting personal email',()=>{
 const uid=jit('bob');store.applyDesiredState(issuer,state('bob','BOB@company.test'));
 expect(grant('bob@company.test')).toMatchObject({status:200,body:{pending:false}});
 expect(db.prepare('SELECT email FROM users WHERE id=?').get(uid)).toEqual({email:'bob@personal.test'});
 expect(db.prepare('SELECT user_id,path,role FROM drive_members WHERE user_id=?').get(uid)).toEqual({user_id:uid,path:'plans/file.txt',role:'viewer'});
 expect(access('bob@company.test')).toBe('viewer');expect(access('bob@company.test','plans/private.txt')).toBe('none');
});
it('R-RECIPIENT-002 address changes and stale versions never restore former alias',()=>{
 store.applyDesiredState(issuer,state('bob','new@company.test',3));
 store.applyDesiredState(issuer,state('bob','bob@company.test',2));
 expect(access('bob@company.test')).toBe('none');expect(access('new@company.test')).toBe('viewer');
 // Explicit personal grants stay with the account, not with a recycled address.
 const other=jit('new-holder');store.applyDesiredState(issuer,state('new-holder','bob@company.test'));
 expect(access('bob@company.test')).toBe('none');expect(db.prepare('SELECT 1 FROM drive_members WHERE user_id=?').get(other)).toBeUndefined();
});
it('R-RECIPIENT-002 suspended/deprovisioned aliases and other issuers are not recipients',()=>{
 jit('inactive');store.applyDesiredState(issuer,state('inactive','inactive@company.test'));
 store.applyDesiredState(issuer,state('inactive','inactive@company.test',2,'suspended'));
 expect(grant('inactive@company.test')).toMatchObject({status:202});
 store.applyDesiredState(issuer,state('inactive','inactive@company.test',3,'deprovisioned'));
 expect(access('inactive@company.test')).toBe('pending');
 store.resolveOrCreateUserForSubject({issuer:'https://other-sso.test',subject:'foreign',name:'Foreign',email:'foreign@personal.test',emailVerified:true});
 store.applyDesiredState('https://other-sso.test',state('foreign','foreign@company.test'));
 expect(grant('foreign@company.test')).toMatchObject({status:202});
});
it('R-RECIPIENT-002 adapter disabled ignores stored aliases',()=>{
 delete process.env.AINDRIVE_SSO_CLIENT_ID;
 try{expect(access('new@company.test')).toBe('none');}finally{process.env.AINDRIVE_SSO_CLIENT_ID='drive-client';}
});
it('R-RECIPIENT-003 ambiguous aliases and direct-email collisions reject grants and do not claim invites',()=>{
 jit('one');jit('two');store.applyDesiredState(issuer,state('one','collision@company.test'));
 invites.addInvite('drive','collision@company.test','pending.txt','editor','owner');
 store.applyDesiredState(issuer,state('two','collision@company.test'));
 expect(grant('collision@company.test')).toMatchObject({status:409});expect(access('collision@company.test')).toBe('none');
 expect(db.prepare("SELECT COUNT(*) n FROM drive_invites WHERE email='collision@company.test'").get()).toEqual({n:1});
 db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)').run('direct','new@company.test','Other','unused');
 expect(grant('new@company.test')).toMatchObject({status:409});expect(access('new@company.test')).toBe('none');
});
it('R-RECIPIENT-004 active provisioning claims pending invitations with path and upgrade-only role',()=>{
 const uid=jit('invitee');expect(grant('invitee@company.test')).toMatchObject({status:202});
 store.applyDesiredState(issuer,state('invitee','invitee@company.test'));
 expect(access('invitee@company.test')).toBe('viewer');expect(access('invitee@company.test','other.txt')).toBe('none');
 expect(db.prepare("SELECT 1 FROM drive_invites WHERE email='invitee@company.test'").get()).toBeUndefined();
 invites.addInvite('drive','invitee@company.test','plans/file.txt','viewer','owner');
 db.prepare("UPDATE drive_members SET role='editor' WHERE user_id=?").run(uid);
 store.applyDesiredState(issuer,state('invitee','invitee@company.test',2));expect(access('invitee@company.test')).toBe('editor');
});

it('R-RECIPIENT-001 identical alias across organizations of one subject is unambiguous',()=>{
 jit('multi');store.applyDesiredState(issuer,state('multi','multi@company.test',1,'active','a'));
 store.applyDesiredState(issuer,state('multi','multi@company.test',1,'active','b'));
 expect(grant('MULTI@company.test')).toMatchObject({status:200});
});
it('R-RECIPIENT-002 malformed or reserved provisioning addresses do not become aliases',()=>{
 jit('invalid');store.applyDesiredState(issuer,state('invalid','not an email'));
 expect(db.prepare("SELECT work_email FROM sso_memberships WHERE subject='invalid'").get()).toEqual({work_email:null});
 store.applyDesiredState(issuer,state('invalid','reserved@sso.aindrive.local',2));
 expect(db.prepare("SELECT work_email FROM sso_memberships WHERE subject='invalid'").get()).toEqual({work_email:null});
});
