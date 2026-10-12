import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
const proxy = createServer((req,res) => { res.setHeader('content-type','text/html');res.end('<body>Fixture</body>'); });
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const executablePath=[chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser=await chromium.launch({executablePath,headless:true});
try {
  const context=await browser.newContext({proxy:{server:`http://127.0.0.1:${proxy.address().port}`}});
  const page=await context.newPage();
  const session=await context.newCDPSession(page);
  for(const name of ['Page.frameAttached','Page.frameDetached','Page.frameNavigated','Target.attachedToTarget','Target.detachedFromTarget']) {
    session.on(name,event=>{
      console.log(JSON.stringify({name,event}));
      if(name==='Target.detachedFromTarget') {
        void session.send('Page.getFrameTree').then(tree=>console.log(JSON.stringify({name:'tree-at-detach',tree}))).catch(()=>{});
        void session.send('Target.getTargetInfo',{targetId:event.targetId}).then(target=>console.log(JSON.stringify({name:'target-at-detach',target}))).catch(()=>{});
      }
    });
  }
  await session.send('Page.enable');
  await session.send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:false,filter:[{type:'iframe'},{exclude:true}]});
  await page.goto('http://8.8.8.8/main');
  await page.evaluate(()=>{const f=document.createElement('iframe');f.src='http://1.1.1.1/frame';document.body.append(f);});
  await page.waitForTimeout(300);
  console.log(JSON.stringify({name:'tree-before-navigation',tree:await session.send('Page.getFrameTree')}));
  await page.goto('http://8.8.8.8/next');
  await page.waitForTimeout(300);
  await context.close();
} finally {await browser.close();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
