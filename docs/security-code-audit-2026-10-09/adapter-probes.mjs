import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
process.env.OPEN_WEBSEARCH_QUIET_STARTUP='true';
const root=process.cwd();const auditRoot=path.join(process.env.TEMP,'open-websearch-security-audit-20261009');
const {config}=await import(pathToFileURL(path.join(root,'build/config.js')));
const {createOpenWebSearchRuntime}=await import(pathToFileURL(path.join(root,'build/runtime/createRuntime.js')));
const {startLocalDaemon}=await import(pathToFileURL(path.join(root,'build/adapters/http/localDaemon.js')));
const request=(port,url,{headers={},body,method=body?'POST':'GET'}={})=>new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:JSON.stringify(body);
  const req=http.request({host:'127.0.0.1',port,path:url,method,headers:{...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...headers},timeout:5000},res=>{let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('fixture timeout')));if(payload)req.write(payload);req.end();
});
const findings=[];let executed=0;
const runtime=createOpenWebSearchRuntime({dependencies:{searchExecutors:{exa:async()=>{executed++;return [];}},fetchWebContent:async(url)=>({url,finalUrl:url,contentType:'text/plain',title:'fixture',retrievalMethod:'request',truncated:false,content:'AUDIT_PUBLIC_FIXTURE'})}});
const daemon=await startLocalDaemon(runtime,{port:0});
try{
  const status=await request(daemon.port,'/status',{headers:{Host:'attacker.test',Origin:'https://attacker.test'}});
  findings.push({test:'daemon-foreign-host-origin',status:status.status,responseStatus:JSON.parse(status.body).status});
  const engines=Array(256).fill('exa');
  const amplification=await request(daemon.port,'/search',{headers:{Host:'attacker.test',Origin:'https://attacker.test'},body:{query:'audit fixture',engines,limit:1}});
  findings.push({test:'duplicate-engine-amplification',inputEngines:engines.length,limit:1,status:amplification.status,executorCalls:executed});
}finally{await daemon.close();}
const reserver=http.createServer();reserver.listen(0,'127.0.0.1');await once(reserver,'listening');const port=reserver.address().port;await new Promise(resolve=>reserver.close(resolve));
const child=spawn(process.execPath,[path.join(root,'build/index.js')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MODE:'http',PORT:String(port),NODE_ENV:'production',ENABLE_CORS:'true',CORS_ORIGIN:'*',SEARCH_MODE:'request',OPEN_WEBSEARCH_QUIET_STARTUP:'true'}});
let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume();
const sessionIds=[];
try{
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('MCP fixture startup timeout')),10000);
    const listener=()=>{if(stderr.includes('HTTP server running')){clearTimeout(timer);child.stderr.removeListener('data',listener);resolve();}};child.stderr.on('data',listener);listener();child.once('exit',code=>{clearTimeout(timer);reject(new Error('MCP fixture exited '+code));});
  });
  const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'audit-local-fixture',version:'1.0'}}};
  for(let i=0;i<3;i++){
    const response=await request(port,'/mcp',{headers:{Host:'attacker.test',Origin:'https://attacker.test',Accept:'application/json, text/event-stream'},body:{...init,id:i+1}});
    const id=response.headers['mcp-session-id'];if(id)sessionIds.push(id);
    if(i===0)findings.push({test:'mcp-no-auth-foreign-host-origin',status:response.status,sessionCreated:Boolean(id),allowOrigin:response.headers['access-control-allow-origin']});
  }
  if(sessionIds.length){
    const response=await request(port,'/mcp',{headers:{Host:'attacker.test',Origin:'https://attacker.test',Accept:'application/json, text/event-stream','mcp-session-id':sessionIds[0]},body:{jsonrpc:'2.0',id:10,method:'tools/list'}});
    findings.push({test:'unauthenticated-tool-discovery',status:response.status,containsFetchWebTool:response.body.includes('fetchWebContent'),liveSessionsCreated:sessionIds.length});
  }
}finally{
  for(const id of sessionIds)await request(port,'/mcp',{method:'DELETE',headers:{'mcp-session-id':id}}).catch(()=>undefined);
  const exited=once(child,'exit');child.kill();await exited;
}
const syntheticProxy=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(path.join(root,'build/config.js')).href)})`],{windowsHide:true,encoding:'utf8',env:{...process.env,OPEN_WEBSEARCH_QUIET_STARTUP:'false',USE_PROXY:'true',PROXY_URL:'http://audit-user:AUDIT_DUMMY_PASSWORD@127.0.0.1:7890',PLAYWRIGHT_WS_ENDPOINT:'ws://127.0.0.1:65530/path?token=AUDIT_DUMMY_TOKEN'}});
findings.push({test:'credential-logging',proxyPasswordLogged:(syntheticProxy.stderr||'').includes('AUDIT_DUMMY_PASSWORD'),remoteTokenLogged:(syntheticProxy.stderr||'').includes('AUDIT_DUMMY_TOKEN')});
for(const result of findings)console.log(JSON.stringify(result));
fs.writeFileSync(path.join(auditRoot,'adapter-probes.json'),JSON.stringify(findings,null,2));
