import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const directory = path.join(root, 'docs/security-code-audit-2026-10-10');
const report = path.join(root, 'docs/security-code-audit-2026-10-10.md');
const readJson = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, ''));
const sha256 = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const writeJson = (name, data) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data, null, 2) + '\n');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const relative = filename => path.relative(root, filename).replaceAll('\\', '/');

const baseline = readJson('source-before.json');
const after = walk(path.join(root, 'src')).filter(filename => filename.endsWith('.ts'))
  .map(filename => ({ Path: filename, Hash: sha256(filename).toUpperCase() }));
writeJson('source-after.json', after);
const beforeByPath = new Map(baseline.map(item => [item.Path.toLowerCase(), item.Hash.toUpperCase()]));
const afterByPath = new Map(after.map(item => [item.Path.toLowerCase(), item.Hash]));
const sourceChanges = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])]
  .filter(filename => beforeByPath.get(filename) !== afterByPath.get(filename));
const inventory = readJson('static-inventory.json');
const infrastructureChanges = inventory.infrastructure.filter(item =>
  !fs.existsSync(path.join(root, item.path)) || sha256(path.join(root, item.path)) !== item.sha256)
  .map(item => item.path);

const gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
fs.writeFileSync(path.join(directory, 'git-status-after.txt'), gitStatus);
const normalizedStatus = value => value.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/)
  .filter(line => line && !/^\?\? docs\/security-code-audit-2026-10-10(?:\.md|\/)$/.test(line)).sort();
const previousStatus = normalizedStatus(fs.readFileSync(path.join(directory, 'git-status-before.txt'), 'utf8'));
const currentStatus = normalizedStatus(gitStatus);
const unrelatedGitStatusUnchanged = JSON.stringify(previousStatus) === JSON.stringify(currentStatus);

const findings = readJson('findings.json');
const invalidLocations = findings.flatMap(finding => finding.locations.filter(location => {
  const filename = path.join(root, location.path);
  return !fs.existsSync(filename) || location.line < 1 || location.line > fs.readFileSync(filename, 'utf8').split('\n').length;
}).map(location => ({ id: finding.id, ...location })));
const missingEvidence = findings.flatMap(finding => finding.evidence.filter(name => !fs.existsSync(path.join(directory, name)))
  .map(name => ({ id: finding.id, name })));
// Manifest is produced below; all other local links must already exist.
const invalidReportLinks = [];
for (const markdownFile of [report, path.join(directory, 'README.md')]) {
  const content = fs.readFileSync(markdownFile, 'utf8');
  for (const match of content.matchAll(/\]\((D:\/[^)]+)\)/g)) {
    const target = match[1].replace(/:\d+$/, '');
    const line = /:(\d+)$/.exec(match[1])?.[1];
    if (path.resolve(target) === path.resolve(path.join(directory, 'manifest.json'))) continue;
    if (!fs.existsSync(target) || (line && Number(line) > fs.readFileSync(target, 'utf8').split('\n').length)) {
      invalidReportLinks.push({ from: relative(markdownFile), target: match[1] });
    }
  }
}

const regressions = readJson('regression-results.json');
const regressionSummary = { total: regressions.length, passed: regressions.filter(item => item.exitCode === 0).length,
  failed: regressions.filter(item => item.exitCode !== 0).length, skipped: regressions.filter(item => item.skipped).length,
  failedTests: regressions.filter(item => item.exitCode !== 0).map(item => item.test) };
const severityCounts = Object.fromEntries(['critical', 'high', 'medium', 'low'].map(severity =>
  [severity, findings.filter(finding => finding.severity === severity).length]));
const npmAll = readJson('npm-audit-all.json');
const npmProduction = readJson('npm-audit-production.json');
const browser = readJson('browser-probes.json');
const evidenceFiles = [report, ...walk(directory).filter(filename => path.basename(filename) !== 'manifest.json')]
  .sort().map(filename => ({ path: relative(filename), bytes: fs.statSync(filename).size, sha256: sha256(filename) }));
const checks = { sourceFilesUnchanged: sourceChanges.length === 0, comparedSourceFiles: baseline.length,
  sourceChanges, infrastructureUnchangedSinceInventory: infrastructureChanges.length === 0, infrastructureChanges,
  unrelatedGitStatusUnchanged, invalidLocations, missingEvidence, invalidReportLinks };
const manifest = { finalizedAt: new Date().toISOString(), auditDate: '2026-10-10', timezone: 'Asia/Shanghai',
  root, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
  scope: 'Current working directory, including pre-existing uncommitted and untracked source; source review plus isolated fixtures.',
  runtime: { node: process.version, nodePath: process.execPath, nodeSha256: sha256(process.execPath), npm: '10.9.8',
    platform: process.platform, browser: browser.metadata },
  staticSummary: inventory.summary, build: { passed: true, log: 'build.log' },
  dependencies: { all: npmAll.metadata.vulnerabilities, production: npmProduction.metadata.vulnerabilities,
    lockEntries: inventory.summary.dependencyEntries, installedVersionDrift: inventory.dependencyDrift },
  findings: { total: findings.length, ...severityCounts, conditionalRatings: true }, regression: regressionSummary,
  safety: { targets: 'Audit-owned loopback fixtures; simulated public DNS views; fake credentials; no production exploitation.',
    metadataProbeRealSignals: 0, metadataProbeRealFileDeletions: 0, sourceFixesApplied: false,
    notExecuted: ['Full live/online integration suite', 'Semgrep/CodeQL/Gitleaks', 'Container image vulnerability scan',
      'Linux cross-user integration exploit', 'Production DNS rebinding', 'Real credential validity checks', 'Full Git history secret scan'] },
  checks, evidenceFiles };
writeJson('manifest.json', manifest);
console.log(JSON.stringify({ findings: manifest.findings, regression: regressionSummary, dependencies: manifest.dependencies,
  checks, evidenceFiles: evidenceFiles.length }, null, 2));
if (!checks.sourceFilesUnchanged || !checks.infrastructureUnchangedSinceInventory || !checks.unrelatedGitStatusUnchanged
  || invalidLocations.length || missingEvidence.length || invalidReportLinks.length) process.exitCode = 1;
