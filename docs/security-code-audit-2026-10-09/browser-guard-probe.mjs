import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
process.env.OPEN_WEBSEARCH_QUIET_STARTUP='true';
const root=process.cwd();
const require=createRequire(path.join(root,'package.json'));
const {chromium}=require('playwright');
const safety=await import(pathToFileURL(path.join(root,'build/utils/urlSafety.js')));
const {installNavigationGuard}=await import(pathToFileURL(path.join(root,'build/utils/browserCookies.js')));
const {getSystemBrowserCandidates}=await import(pathToFileURL(path.join(root,'build/utils/browserPaths.js')));
const auditRoot=path.join(process.env.TEMP,'open-websearch-security-audit-20261009');
const privateHits=[];
const privateServer=http.createServer((req,res)=>{
  privateHits.push({path:req.url,host:req.headers.host});
  res.setHeader('Content-Type',req.url.includes('image')?'image/svg+xml':'text/html');
  res.end(req.url.includes('image')?'<svg xmlns="http://www.w3.org/2000/svg"></svg>':'<html><title>Audit private fixture</title><body>AUDIT_PRIVATE_SENTINEL</body></html>');
});
const listen=server=>new Promise((resolve,reject)=>{server.on('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());});
const privatePort=await listen(privateServer);
const publicServer=http.createServer((req,res)=>{
  if(req.url==='/redirect'||req.url==='/redirect-image'){
    res.writeHead(302,{Location:`http://127.0.0.1:${privatePort}/${req.url==='/redirect'?'redirect-target':'image-target'}`});res.end();return;
  }
  res.setHeader('Content-Type','text/html');
  if(req.url==='/popup'){
    res.end(`<html><body>Public fixture<script>window.open('http://127.0.0.1:${privatePort}/popup-target','audit-popup')</script></body></html>`);return;
  }
  if(req.url==='/image-page'){
    res.end('<html><body>Public fixture<img src="/redirect-image"></body></html>');return;
  }
  res.end('<html><body>Public fixture</body></html>');
});
const publicPort=await listen(publicServer);
const dnsChecks=[];
safety.__setDnsLookupForTests(async hostname=>{dnsChecks.push(hostname);if(hostname!=='audit-public.test')throw new Error('Unexpected hostname in isolated fixture');return [{address:'93.184.216.34'}];});
let browser;
const results=[];
try{
  const executablePath=getSystemBrowserCandidates().find(candidate=>fs.existsSync(candidate));
  if(!executablePath)throw new Error('No isolated browser binary available');
  browser=await chromium.launch({executablePath,headless:true,args:['--host-resolver-rules=MAP audit-public.test 127.0.0.1','--no-proxy-server','--disable-background-networking']});
  console.log(JSON.stringify({browserVersion:browser.version(),executablePath}));
  for(const [test,endpoint] of [['navigation-redirect','/redirect'],['subresource-redirect','/image-page'],['popup-first-request','/popup']]){
    const context=await browser.newContext();
    const page=await context.newPage();
    const before=privateHits.length;
    await installNavigationGuard(page);
    let navigationError;
    try{await page.goto(`http://audit-public.test:${publicPort}${endpoint}`,{waitUntil:'load',timeout:10000});await page.waitForTimeout(500);}catch(e){navigationError=e.message;}
    const result={test,privateHits:privateHits.slice(before),finalUrl:page.url(),navigationError,bodyContainsPrivateSentinel:(await page.content()).includes('AUDIT_PRIVATE_SENTINEL')};
    results.push(result);console.log(JSON.stringify(result));
    await context.close();
  }
}finally{
  if(browser)await browser.close();
  safety.__setDnsLookupForTests();
  await close(publicServer);await close(privateServer);
  fs.writeFileSync(path.join(auditRoot,'browser-guard-probe.json'),JSON.stringify({fixture:'Initial public server is simulated with an isolated DNS safety hook and Chromium host mapping. All sockets target audit-owned loopback services.',dnsChecks,results},null,2));
}
