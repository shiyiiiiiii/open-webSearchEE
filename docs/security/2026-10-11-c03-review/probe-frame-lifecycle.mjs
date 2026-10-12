import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { config } from '../../../build/config.js';
import { createControlledBrowserTask } from '../../../build/utils/browserNetworkPolicy.js';
import { fetchPageHtmlWithBrowser } from '../../../build/utils/browserCookies.js';

// Review fixture: all HTTP responses are generated locally; no upstream access.
const proxy = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (new URL(req.url).pathname === '/auto') {
    res.end('<!doctype html><body>Fixture<iframe src="http://1.1.1.1/frame" onload="setTimeout(()=>location.href=\'http://8.8.8.8/next\',50)"></iframe></body>');
    return;
  }
  res.end('<!doctype html><body>Fixture</body>');
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const executablePath = [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const server = await chromium.launchServer({ executablePath, headless: true, host:'127.0.0.1' });
const browser = await chromium.connect({wsEndpoint:server.wsEndpoint()});
config.playwrightWsEndpoint = server.wsEndpoint();
config.playwrightCdpEndpoint = undefined;
process.env.OPEN_WEBSEARCH_PROFILE_DIR = `c03-review-${process.pid}`;
config.browserEgressEnforced = true;
config.browserEgressProxyUrl = `http://127.0.0.1:${proxy.address().port}`;
config.browserAllowedPorts = [80,443];
try {
  for (const action of ['same-site', 'about-blank', 'remove', 'main-navigation', 'main-navigation', 'main-navigation', 'page-redirect', 'page-redirect', 'page-redirect']) {
    const task = await createControlledBrowserTask(browser);
    try {
      await task.run(async () => {
        await task.page.goto('http://8.8.8.8/main');
        await task.page.evaluate(() => {
          const frame = document.createElement('iframe'); frame.id='fixture';
          frame.src = 'http://1.1.1.1/frame'; document.body.append(frame);
        });
        await task.page.waitForFunction(() => document.querySelector('iframe') !== null);
        for (let i=0; i<30 && !task.page.frames().some(f=>f.url()==='http://1.1.1.1/frame'); i++) await new Promise(r=>setTimeout(r,30));
        if (!task.diagnostics.guardedChildTargets) throw Error('OOPIF not exercised');
        if (action === 'main-navigation') await task.page.goto('http://8.8.8.8/next');
        else if (action === 'page-redirect') {
          await task.page.evaluate(() => { setTimeout(() => { location.href='http://8.8.8.8/next'; }, 10); });
          await task.page.waitForURL('http://8.8.8.8/next');
        }
        else await task.page.evaluate(action => {
          const frame = document.getElementById('fixture');
          if (action === 'remove') frame.remove();
          else frame.src = action === 'about-blank' ? 'about:blank' : 'http://8.8.8.8/frame';
        }, action);
        await task.page.waitForTimeout(500);
        await task.page.content();
      });
      console.log(JSON.stringify({action, result:'PASS', diagnostics:task.diagnostics}));
    } catch (e) { process.exitCode=1; console.log(JSON.stringify({action,result:'FAIL',code:e.code,message:e.message})); }
    finally { await task.close(); }
  }
  for(let i=0;i<3;i++) {
    try {
      const result = await fetchPageHtmlWithBrowser('http://8.8.8.8/auto');
      console.log(JSON.stringify({action:'production-html-fetch',result:'PASS',finalUrl:result.finalUrl}));
    } catch(e) {
      process.exitCode=1;
      console.log(JSON.stringify({action:'production-html-fetch',result:'FAIL',code:e.code,message:e.message}));
    }
  }
} finally {
  await browser.close(); await server.close(); proxy.closeAllConnections(); await new Promise(r=>proxy.close(r));
}
