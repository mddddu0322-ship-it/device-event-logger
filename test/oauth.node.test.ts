// Run with: node --experimental-strip-types --test test/oauth.node.test.ts
// Requires @electric-sql/pglite in OAUTH_TEST_MODULES (test-only, never a production dependency).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { hash, OAUTH_ISSUER as base, MCP_RESOURCE as resource } from '../src/routes/oauth.ts';
const { PGlite } = await import(process.env.OAUTH_TEST_MODULES + '/@electric-sql/pglite/dist/index.js');
const db = new PGlite();
const sql = { unsafe: async (q: string, args?: unknown[]) => {
  if (!args && q.includes('CREATE TABLE')) { await db.exec(q); return []; }
  return (await db.query(q,args)).rows;
}};
const app=createApp({createSql:()=>sql as any});
const env={API_KEY:'local-test-owner-key',DATABASE_URL:'unused',TZ_OFFSET:'480'};
const request=(path: string, init: RequestInit={})=>app.fetch(new Request(base+path,init),env);
const form=(b: Record<string,string>, headers: Record<string,string>={})=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(b)});
let client='', code='', access='', refresh='';
const redirect='https://chatgpt.com/connector_platform_oauth_redirect', verifier='v'.repeat(64);
let pending='',cookie='';

test('OAuth metadata advertises canonical issuer, resource, PKCE and DCR',async()=>{
  const meta=await (await request('/.well-known/oauth-authorization-server')).json();
  assert.equal(meta.issuer,base); assert.deepEqual(meta.code_challenge_methods_supported,['S256']);
  assert.equal(meta.token_endpoint_auth_methods_supported[0],'none');
  const protectedMeta=await (await request('/.well-known/oauth-protected-resource')).json();
  assert.equal(protectedMeta.resource,resource);
  const blocked=await request('/mcp',{method:'POST'}); assert.equal(blocked.status,401);
  assert.match(blocked.headers.get('www-authenticate')!,/resource_metadata=/);
});
test('registration rejects attacker redirects and creates public ChatGPT client',async()=>{
  for(const uri of ['https://chatgpt.com.evil.test/connector_platform_oauth_redirect','https://evil.test/callback','http://chatgpt.com/connector_platform_oauth_redirect','https://chatgpt.com/other','https://chatgpt.com@evil.test/callback']) {
    assert.equal((await request('/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:[uri]})})).status,400);
  }
  const res=await request('/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({redirect_uris:[redirect],token_endpoint_auth_method:'none'})});
  assert.equal(res.status,201); client=(await res.json()).client_id;
});
const authorize=()=>'/oauth/authorize?'+new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',resource,scope:'events',code_challenge_method:'S256',code_challenge:hash(verifier),state:'state-check'});
test('authorization enforces redirect/resource, CSRF, owner key and one-time consent',async()=>{
  assert.equal((await request(authorize().replace(encodeURIComponent(resource),encodeURIComponent('https://evil.test')))).status,400);
  const res=await request(authorize()); assert.equal(res.status,200);
  const html=await res.text(); assert.ok(!html.includes(env.API_KEY));
  pending=html.match(/name="request" value="([^"]+)"/)![1];
  cookie=res.headers.get('set-cookie')!.split(';')[0];
  assert.match(res.headers.get('set-cookie')!,/HttpOnly/); assert.match(res.headers.get('set-cookie')!,/Secure/);
  assert.equal((await request('/oauth/authorize',form({request:pending,key:env.API_KEY},{origin:base}))).status,400);
  assert.equal((await request('/oauth/authorize',form({request:pending,key:env.API_KEY},{cookie,origin:'https://evil.test'}))).status,403);
  assert.equal((await request('/oauth/authorize',form({request:pending,key:'wrong'},{cookie,origin:base}))).status,401);
  const ok=await request('/oauth/authorize',form({request:pending,key:env.API_KEY},{cookie,origin:base}));
  assert.equal(ok.status,303);const target=new URL(ok.headers.get('location')!);
  assert.equal(target.searchParams.get('state'),'state-check');assert.equal(target.searchParams.get('iss'),base);code=target.searchParams.get('code')!;
  assert.equal((await request('/oauth/authorize',form({request:pending,key:env.API_KEY},{cookie,origin:base}))).status,400);
});
const exchange=(overrides: Record<string,string>={})=>form({grant_type:'authorization_code',code,client_id:client,redirect_uri:redirect,code_verifier:verifier,resource,...overrides});
test('token exchange verifies PKCE/client/resource and prevents code replay',async()=>{
  for(const overrides of [{code_verifier:'x'.repeat(64)},{client_id:'wrong'},{redirect_uri:'https://evil.test'},{resource:'https://evil.test'}]) assert.equal((await request('/oauth/token',exchange(overrides))).status,400);
  const ok=await request('/oauth/token',exchange());assert.equal(ok.status,200);const b=await ok.json();access=b.access_token;refresh=b.refresh_token;
  assert.equal(b.expires_in,3600);assert.equal((await request('/oauth/token',exchange())).status,400);
  const rows=await db.query('SELECT id FROM oauth_tokens'); assert.ok(rows.rows.every((r:any)=>r.id!==access && r.id!==refresh));
});
test('OAuth permits MCP reads and cannot authenticate Shortcut writes',async()=>{
  const mcp=await request('/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+access},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'query_events',arguments:{hours:24}}})});
  assert.equal(mcp.status,200); assert.equal((await mcp.json()).result.isError,false);
  assert.equal((await request('/events',form({},{authorization:'Bearer '+access}))).status,401);
  assert.equal((await request('/mcp',{method:'POST',headers:{authorization:'Bearer mcp_at_invalid'}})).status,401);
  assert.equal((await request('/events?hours=1',{headers:{authorization:env.API_KEY}})).status,200);
});
test('refresh rotates tokens, rejects replay; expired and revoked access denied',async()=>{
  assert.equal((await request('/oauth/token',form({grant_type:'refresh_token',refresh_token:refresh,client_id:'wrong',resource}))).status,400);
  const b=await (await request('/oauth/token',form({grant_type:'refresh_token',refresh_token:refresh,client_id:client,resource}))).json();
  assert.ok(b.access_token);assert.notEqual(b.refresh_token,refresh);
  assert.equal((await request('/oauth/token',form({grant_type:'refresh_token',refresh_token:refresh,client_id:client,resource}))).status,400);
  await db.query("UPDATE oauth_tokens SET expires=now()-interval '1 second' WHERE id=$1",[hash(access)]);
  assert.equal((await request('/mcp',{method:'POST',headers:{authorization:'Bearer '+access}})).status,401);
  assert.equal((await request('/oauth/revoke',form({token:b.access_token,client_id:client}))).status,200);
  assert.equal((await request('/mcp',{method:'POST',headers:{authorization:'Bearer '+b.access_token}})).status,401);
  await db.close();
});
