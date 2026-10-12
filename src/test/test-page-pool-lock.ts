import assert from 'node:assert/strict';
import { config } from '../config.js';
import { acquirePooledPlaywrightPage } from '../utils/playwrightClient.js';
import { RESOURCE_LIMITS } from '../utils/resourceLimits.js';
import { makeControlledBrowserMock } from './helpers/controlledBrowserMock.js';

async function run() {
    process.env.OPEN_WEBSEARCH_PROFILE_DIR = `c03-test-capacity-${process.pid}`;
    config.browserEgressEnforced = true;
    config.browserEgressProxyUrl = 'http://127.0.0.1:3128';
    const a = makeControlledBrowserMock(), b = makeControlledBrowserMock();
    const results = await Promise.allSettled(Array.from({ length: RESOURCE_LIMITS.maxBrowserPages + 2 }, (_, index) =>
        acquirePooledPlaywrightPage(index % 2 ? a.browser : b.browser, { poolKey: 'capacity-' + index })
    ));
    const admitted = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    assert.equal(admitted.length, RESOURCE_LIMITS.maxBrowserPages);
    assert.equal(new Set(admitted.map(task => task.context)).size, RESOURCE_LIMITS.maxBrowserPages);
    for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'resource_limit');
    await admitted[0].releasePage();
    const fresh = await acquirePooledPlaywrightPage(a.browser, { poolKey: 'capacity-0', contextOptions: { locale: 'en-US' } });
    assert.notEqual(fresh.page, admitted[0].page);
    assert.equal(fresh.context.options.locale, 'en-US');
    assert(admitted[0].context.closed, 'release closes all task state instead of returning it to another caller');
    await fresh.releasePage();
    await fresh.releasePage();
    await Promise.all(admitted.slice(1).map(task => task.releasePage()));
    await assert.rejects(acquirePooledPlaywrightPage(a.browser, { preferExistingContext: true }), { code: 'browser_guard_unavailable' });
    await assert.rejects(acquirePooledPlaywrightPage(a.browser, { preparePage: async () => { throw Error('preparation failed'); } }));
    const afterFailure = await acquirePooledPlaywrightPage(a.browser);
    await afterFailure.releasePage();
    console.log('PASS: global capacity across browsers/pools, isolated tasks, idempotent release and failure recovery');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
