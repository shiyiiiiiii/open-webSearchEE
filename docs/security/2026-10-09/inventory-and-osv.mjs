import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const outputDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(outputDir, '../../..');
const save = (name, data) => fs.writeFileSync(path.join(outputDir, name), JSON.stringify(data, null, 2) + '\n');
const hash = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const locked = Object.entries(lock.packages).filter(([location, item]) => location && item.version).map(([location, item]) => ({
  name: item.name || location.split('node_modules/').pop(),
  version: item.version,
  location,
  developmentOnly: !!item.dev,
  optional: !!item.optional,
  directProduction: Object.hasOwn(manifest.dependencies || {}, item.name || location.split('node_modules/').pop()) && location === `node_modules/${item.name || location.split('node_modules/').pop()}`,
  directDevelopment: Object.hasOwn(manifest.devDependencies || {}, item.name || location.split('node_modules/').pop()) && location === `node_modules/${item.name || location.split('node_modules/').pop()}`,
  integrity: item.integrity || null,
}));
const installed = [];
const skipped = [];
const visited = new Set();
function scanModules(directory) {
  if (!fs.existsSync(directory)) return;
  const real = fs.realpathSync(directory);
  if (visited.has(real)) return;
  visited.add(real);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const target = path.join(directory, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of fs.readdirSync(target, { withFileTypes: true })) scanPackage(path.join(target, child.name));
    } else if (entry.isDirectory() || entry.isSymbolicLink()) scanPackage(target);
  }
}
function scanPackage(directory) {
  const filename = path.join(directory, 'package.json');
  if (!fs.existsSync(filename)) { skipped.push({ location: path.relative(root, directory).replaceAll('\\', '/'), reason: 'No package.json' }); return; }
  const item = JSON.parse(fs.readFileSync(filename, 'utf8'));
  installed.push({ name: item.name, version: item.version, location: path.relative(root, directory).replaceAll('\\', '/') });
  scanModules(path.join(directory, 'node_modules'));
}
scanModules(path.join(root, 'node_modules'));
const installedByLocation = new Map(installed.map(item => [item.location, item]));
const missing = locked.filter(item => !installedByLocation.has(item.location));
const mismatched = locked.filter(item => installedByLocation.has(item.location) && (installedByLocation.get(item.location).version !== item.version || installedByLocation.get(item.location).name !== item.name));
const lockLocations = new Set(locked.map(item => item.location));
const extraneous = installed.filter(item => !lockLocations.has(item.location));
const installedLocations = new Set(installed.map(item => item.location));
const embeddedMetadata = execFileSync('rg', ['--files', '--hidden', '--no-ignore', '-g', 'package.json', 'node_modules'], { cwd: root, encoding: 'utf8' })
  .trim().split(/\r?\n/).filter(Boolean).map(filename => filename.replaceAll('\\', '/'))
  .filter(filename => !installedLocations.has(filename.replace(/\/package\.json$/, '')))
  .map(filename => {
    const item = JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8'));
    return { name: item.name, version: item.version, location: filename.replace(/\/package\.json$/, ''), private: !!item.private, kind: 'Embedded package metadata; npm identity not assumed' };
  }).filter(item => item.name && item.version);
const unique = new Map();
for (const item of locked) {
  const key = `${item.name}@${item.version}`;
  if (!unique.has(key)) unique.set(key, { name: item.name, version: item.version, lockLocations: [], installedLocations: [] });
  unique.get(key).lockLocations.push(item.location);
}
for (const item of installed) {
  const key = `${item.name}@${item.version}`;
  if (!unique.has(key)) unique.set(key, { name: item.name, version: item.version, lockLocations: [], installedLocations: [] });
  unique.get(key).installedLocations.push(item.location);
}
for (const item of embeddedMetadata) {
  const key = `${item.name}@${item.version}`;
  if (!unique.has(key)) unique.set(key, { name: item.name, version: item.version, lockLocations: [], installedLocations: [], embeddedMetadataLocations: [] });
  if (!unique.get(key).embeddedMetadataLocations) unique.get(key).embeddedMetadataLocations = [];
  unique.get(key).embeddedMetadataLocations.push(item.location);
}
const inventory = {
  capturedAt: new Date().toISOString(),
  capturedAtShanghai: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' +08:00',
  project: { name: manifest.name, version: manifest.version, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), lockfileVersion: lock.lockfileVersion },
  hashes: { 'package.json': hash('package.json'), 'package-lock.json': hash('package-lock.json') },
  runtime: { node: process.version, versions: process.versions, platform: process.platform, architecture: process.arch },
  counts: { lockEntries: locked.length, uniqueLocked: new Set(locked.map(item => `${item.name}@${item.version}`)).size, productionLockEntries: locked.filter(item => !item.developmentOnly).length, developmentOnlyLockEntries: locked.filter(item => item.developmentOnly).length, installedEntries: installed.length, embeddedPackageMetadata: embeddedMetadata.length, uniqueQueried: unique.size },
  locked, installed, missing, mismatched, extraneous, embeddedMetadata, skipped,
};
save('dependency-inventory.json', inventory);
console.log(JSON.stringify({ counts: inventory.counts, missing, mismatched, extraneous, embeddedMetadata, skipped }));

async function request(url, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
const packages = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const results = [];
const rawResponses = [];
for (let start = 0; start < packages.length; start += 100) {
  const batch = packages.slice(start, start + 100);
  const response = await request('https://api.osv.dev/v1/querybatch', { queries: batch.map(item => ({ package: { ecosystem: 'npm', name: item.name }, version: item.version })) });
  if (response.results?.length !== batch.length) throw new Error(`Incomplete OSV batch at ${start}`);
  rawResponses.push({ start, queriedAt: new Date().toISOString(), response });
  for (let index = 0; index < batch.length; index++) {
    let result = response.results[index];
    const vulnerabilities = [...(result.vulns || [])];
    while (result.next_page_token) {
      result = await request('https://api.osv.dev/v1/query', { package: { ecosystem: 'npm', name: batch[index].name }, version: batch[index].version, page_token: result.next_page_token });
      vulnerabilities.push(...(result.vulns || []));
    }
    results.push({ ...batch[index], vulnerabilities });
  }
  console.log(`OSV queried ${Math.min(start + 100, packages.length)}/${packages.length} package versions`);
}
save('osv-batch.json', { checkedAt: new Date().toISOString(), endpoint: 'https://api.osv.dev/v1/querybatch', ecosystem: 'npm', packageVersionsQueried: packages.length, rawResponses, results });
const ids = [...new Set(results.flatMap(item => item.vulnerabilities.map(vulnerability => vulnerability.id)))];
const records = [];
for (let start = 0; start < ids.length; start += 8) {
  records.push(...await Promise.all(ids.slice(start, start + 8).map(id => request(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`))));
}
save('osv-advisories.json', { fetchedAt: new Date().toISOString(), records });
console.log(JSON.stringify({ packageVersionsQueried: packages.length, affectedPackages: results.filter(item => item.vulnerabilities.length).map(item => ({ name: item.name, version: item.version, ids: item.vulnerabilities.map(v => v.id) })), advisoryCount: records.length }, null, 2));
