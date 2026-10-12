import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
process.env.OPEN_WEBSEARCH_QUIET_STARTUP='true';
const root=process.cwd();const auditRoot=path.join(process.env.TEMP,'open-websearch-security-audit-20261009');
const axios=(await import(pathToFileURL(path.join(root,'node_modules/axios/index.js')))).default;
const safety=await import(pathToFileURL(path.join(root,'build/utils/urlSafety.js')));
const networking=await import(pathToFileURL(path.join(root,'build/utils/httpRequest.js')));
const {fetchCsdnArticle}=await import(pathToFileURL(path.join(root,'build/engines/csdn/fetchCsdnArticle.js')));
const {fetchJuejinArticle}=await import(pathToFileURL(path.join(root,'build/engines/juejin/fetchJuejinArticle.js')));
const {fetchGithubReadme}=await import(pathToFileURL(path.join(root,'build/engines/github/github.js')));
const {fetchLinuxDoArticle}=await import(pathToFileURL(path.join(root,'build/engines/linuxdo/fetchLinuxDoArticle.js')));
const findings=[];const captures=[];const large='a'.repeat(2*1024*1024+1024);
const describe=(name,options)=>({test:name,effectiveTimeoutMs:options.timeout??axios.defaults.timeout,effectiveMaxContentLength:options.maxContentLength??axios.defaults.maxContentLength,effectiveMaxBodyLength:options.maxBodyLength??axios.defaults.maxBodyLength,maxRedirects:options.maxRedirects??'axios/follow-redirects default'});
safety.__setDnsLookupForTests(async()=>[{address:'93.184.216.34'}]);
networking.__setAxiosRequestForTests(async options=>{captures.push(describe('csdn-request-options',options));return {status:200,data:`<html><body><div id="content_views">${large}</div></body></html>`,headers:{'content-type':'text/html'},config:options,request:{res:{}}};});
try{
  const result=await fetchCsdnArticle('https://blog.csdn.net/audit/article/details/1');
  findings.push({...captures[0],returnedContentChars:result.content.length,exceedsGenericWeb2MiBLimit:result.content.length>2*1024*1024});
}finally{networking.__setAxiosRequestForTests();safety.__setDnsLookupForTests();}
const oldGet=axios.get;
let current;
axios.get=async(url,options)=>{captures.push(describe(current,options));return {status:200,data:current==='linuxdo-request-options'?{post_stream:{posts:[{cooked:'<p>audit fixture</p>'}]}}:'<html><body>audit fixture</body></html>',headers:{},config:options};};
try{
  current='juejin-request-options';await fetchJuejinArticle('https://juejin.cn/post/1');
  current='github-request-options';await fetchGithubReadme('https://github.com/audit/fixture');
  current='linuxdo-request-options';await fetchLinuxDoArticle('https://linux.do/t/topic/1.json');
  findings.push(...captures.slice(1));
}finally{axios.get=oldGet;}
const validation=await import(pathToFileURL(path.join(root,'build/core/validation/targetValidation.js')));
const samples=[['csdn','https://blog.csdn.net/not-an-article?x=/article/details/'],['juejin','http://user:dummy@juejin.cn:8080/not-an-article#post=/post/'],['linuxdo','ftp://linux.do/t/topic/1?x=.json']];
for(const [type,url]of samples)findings.push({test:'article-url-validation',type,url,accepted:validation.validateArticleUrl(url,type)});
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
const audit=JSON.parse(fs.readFileSync(path.join(auditRoot,'npm-audit.json'),'utf8').replace(/^\uFEFF/,''));
const dependencySummary=Object.values(audit.vulnerabilities).map(v=>({name:v.name,severity:v.severity,direct:v.isDirect,versions:v.nodes.map(n=>lock.packages[n].version),nodes:v.nodes,fixAvailable:v.fixAvailable,advisoryCount:v.via.filter(x=>typeof x!=='string').length,advisories:v.via.filter(x=>typeof x!=='string').map(x=>({title:x.title,url:x.url,range:x.range,severity:x.severity})),transitiveEffects:v.via.filter(x=>typeof x==='string')}));
fs.writeFileSync(path.join(auditRoot,'dependency-summary.json'),JSON.stringify(dependencySummary,null,2));
fs.writeFileSync(path.join(auditRoot,'resource-probes.json'),JSON.stringify(findings,null,2));
for(const result of findings)console.log(JSON.stringify(result));
console.log(JSON.stringify({auditMetadata:audit.metadata,distinctAdvisories:new Set(dependencySummary.flatMap(v=>v.advisories.map(a=>a.url))).size}));

