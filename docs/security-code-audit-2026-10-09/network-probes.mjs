import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
process.env.OPEN_WEBSEARCH_QUIET_STARTUP='true';
const root=process.cwd();
const auditRoot=path.join(process.env.TEMP,'open-websearch-security-audit-20261009');
const {config}=await import(pathToFileURL(path.join(root,'build/config.js')));
const safety=await import(pathToFileURL(path.join(root,'build/utils/urlSafety.js')));
const networking=await import(pathToFileURL(path.join(root,'build/utils/httpRequest.js')));
const {fetchJuejinArticle}=await import(pathToFileURL(path.join(root,'build/engines/juejin/fetchJuejinArticle.js')));
const {validateArticleUrl}=await import(pathToFileURL(path.join(root,'build/core/validation/targetValidation.js')));
const listen=server=>new Promise((resolve,reject)=>{server.on('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const close=server=>new Promise(resolve=>{server.closeAllConnections?.();server.close(()=>resolve());});
const received=[];
const connections=[];
const privateServer=http.createServer((req,res)=>{received.push({path:req.url,host:req.headers.host,cookie:req.headers.cookie,authorization:req.headers.authorization});res.setHeader('Content-Type','text/html');res.end('<html><body><div class="markdown-body">AUDIT_PRIVATE_CONTENT</div></body></html>');});
const privatePort=await listen(privateServer);
const publicServer=http.createServer((req,res)=>{
  const cookieProbe=req.url==='/cookie-source';
  res.writeHead(302,{Location:`http://${cookieProbe?'audit-cookie-sink.test':'audit-private.test'}:${privatePort}/${cookieProbe?'cookie-sink':'private-target'}`});res.end();
});
const publicPort=await listen(publicServer);
const sockets=new Set();
const proxy=http.createServer((_req,res)=>{res.writeHead(405);res.end();});
proxy.on('connect',(req,client,head)=>{
  const target=new URL('http://'+req.url);
  const ports={'juejin.cn':publicPort,'audit-split.test':privatePort,'audit-cookie-source.test':publicPort,'audit-cookie-sink.test':privatePort,'audit-private.test':privatePort};
  const port=ports[target.hostname];
  if(!port || Number(target.port)!==port){client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  connections.push(req.url);
  const upstream=net.connect(port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  sockets.add(client);sockets.add(upstream);client.on('close',()=>sockets.delete(client));upstream.on('close',()=>sockets.delete(upstream));client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
});
const proxyPort=await listen(proxy);
const oldConfig={useProxy:config.useProxy,proxyUrl:config.proxyUrl};
config.useProxy=true;config.proxyUrl=`http://127.0.0.1:${proxyPort}`;
const results=[];
try{
  let dnsChecks=[];
  safety.__setDnsLookupForTests(async host=>{dnsChecks.push(host);return [{address:'93.184.216.34'}];});
  const split=await networking.requestWithSafeRedirects('GET',`http://audit-split.test:${privatePort}/split-dns`,networking.buildAxiosRequestOptions({timeout:3000}));
  results.push({test:'proxy-split-dns',nodeDnsChecks:dnsChecks,bodyContainsPrivateSentinel:String(split.data).includes('AUDIT_PRIVATE_CONTENT'),fixture:'Node preflight resolves to a simulated public answer; the controlled proxy resolves the same host to an audit-owned loopback service.'});
  dnsChecks=[];
  safety.__setDnsLookupForTests(async host=>{dnsChecks.push(host);return [{address:'127.0.0.1'}];});
  const juejinUrl=`http://juejin.cn:${publicPort}/post/1`;
  const before=received.length;
  const juejin=await fetchJuejinArticle(juejinUrl);
  results.push({test:'juejin-proxy-redirect-private-dns',inputAccepted:validateArticleUrl(juejinUrl,'juejin'),nodeDnsChecks:dnsChecks,privateHits:received.slice(before),returnedContent:juejin.content,fixture:'A local proxy maps the allowlisted upstream to a local fixture that redirects to a hostname resolving to private IP. Upstream redirect control is required in a real deployment.'});
  safety.__setDnsLookupForTests(async host=>[{address:'93.184.216.34'}]);
  const cookieBefore=received.length;
  await networking.requestWithSafeRedirects('GET',`http://audit-cookie-source.test:${publicPort}/cookie-source`,networking.buildAxiosRequestOptions({timeout:3000,headers:{Cookie:'audit_session=DUMMY_NO_REAL_SECRET',Authorization:'Bearer AUDIT_DUMMY'}}));
  results.push({test:'cross-origin-sensitive-header-forwarding',sinkRequests:received.slice(cookieBefore),fixture:'Only fabricated cookies and authorization values are used.'});
  for(const result of results)console.log(JSON.stringify(result));
}finally{
  Object.assign(config,oldConfig);safety.__setDnsLookupForTests();
  for(const socket of sockets)socket.destroy();
  await close(proxy);await close(publicServer);await close(privateServer);
  fs.writeFileSync(path.join(auditRoot,'network-probes.json'),JSON.stringify({connections,results},null,2));
}
