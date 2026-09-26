import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readChatStream } from 'ain-ui';
const state = vi.hoisted(() => ({ user: 'owner', calls: 0 }));
vi.mock('@/lib/session', () => ({ getRequestUser: async () => state.user === 'invalid' ? 'invalid' : { id: state.user } }));
vi.mock('@/lib/drives', () => ({ getDrive: (id: string) => ({ owner_id: id === 'foreign' ? 'other' : 'owner', drive_secret: 'never-in-stream' }) }));
vi.mock('@/lib/rpc', () => ({ isOnline: () => true }));
vi.mock('@/lib/rate-limit', () => ({ tryConsume: () => ({ok:true}), clientKey: () => 'test' }));
vi.mock('@/lib/cloud-agent', () => ({ CLOUD_AGENT: {name:'Cloud',card:'https://cloud.test/card'}, askCloud: async (opts: any) => {
  state.calls++;
  opts.onUpdate({text:'Partial',contextId:'ctx'});
  return {text:'Complete',contextId:'ctx'};
} }));
const {POST,GET} = await import('../../app/api/drives/[driveId]/folder-chat/route');
const params = {params:Promise.resolve({driveId:'drive'})};
const request = (body: unknown) => new Request('http://test/chat', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
beforeEach(()=>{state.user='owner';state.calls=0;});
describe('authenticated folder chat stream',()=>{
  it('streams updates, AIN-UI activity and a final context without secrets',async()=>{
    const response=await POST(request({q:'question',path:'sub'}),params);
    const body=await response.text();
    expect(body).toContain('ACTIVITY_SNAPSHOT');expect(body).toContain('FolderChat');expect(body).not.toContain('never-in-stream');
    const updates:string[]=[];
    const result=await readChatStream(new Response(body,{headers:{'content-type':'text/event-stream'}}),u=>updates.push(u.text));
    expect(updates).toContain('Partial');expect(result.text).toBe('Complete');expect(result.contextId).toBe('ctx');
    expect(state.calls).toBe(1);
  });
  it('rejects other users, invalid bearers and unknown remote targets before sending',async()=>{
    for(const user of ['other','invalid']) {state.user=user;expect((await POST(request({q:'question'}),params)).status).toBe(403);}
    state.user='owner';expect((await POST(request({q:'question',agentId:'https://private'}),params)).status).toBe(400);
    expect((await POST(request({q:'question',folders:[{driveId:'foreign',path:''}]}),params)).status).toBe(403);
    expect(state.calls).toBe(0);
  });
  it('only returns public agent descriptors',async()=>{
    const r=await GET(new Request('http://test/chat'),params);const data=await r.json();
    expect(data.agents).toEqual([{id:'cloud',label:'Cloud',remote:true}]);
  });
});
