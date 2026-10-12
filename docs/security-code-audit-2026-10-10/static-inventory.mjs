import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const out = path.join(root, 'docs/security-code-audit-2026-10-10');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const files = walk(path.join(root, 'src')).filter(file => file.endsWith('.ts'));
const inventory = [], sinks = [], credentialLiterals = [];
for (const filename of files) {
  const source = fs.readFileSync(filename, 'utf8');
  const relative = path.relative(root, filename).replaceAll('\\', '/');
  const test = relative.startsWith('src/test/');
  inventory.push({ path: relative, test, bytes: Buffer.byteLength(source), lines: source.split('\n').length,
    sha256: crypto.createHash('sha256').update(source).digest('hex') });
  const syntax = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true);
  const visit = node => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = node.expression.getText(syntax);
      const category = /(^|\.)(eval|Function|exec|execSync|execFile|execFileSync|spawn|spawnSync)$/.test(name) ? 'execution'
        : /(^|\.)(readFile|readFileSync|writeFile|writeFileSync|rm|rmSync|unlink|unlinkSync|openSync)$/.test(name) ? 'filesystem'
        : /(^|\.)(fetch|request|goto|connect|connectOverCDP|route|routeWebSocket|evaluate|load|JSDOM)$/.test(name)
          || /^axios\./.test(name) || /requestWithSafeRedirects|buildAxiosRequestOptions/.test(name) ? 'network-or-content' : undefined;
      if (category) sinks.push({ path: relative, line: syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1, category, name, test });
    }
    if (!test && ts.isPropertyAssignment(node)) {
      const key = node.name.getText(syntax).replaceAll(/['"]/g, '');
      if (/^(cookie|authorization|x-csrf-token|password|secret|api[-_]?key)$/i.test(key) && ts.isStringLiteralLike(node.initializer)) {
        credentialLiterals.push({ path: relative, line: syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          key, characters: node.initializer.text.length, valueOmitted: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
}
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const dependencyDrift = [];
for (const [entryPath, data] of Object.entries(lock.packages)) {
  if (!entryPath) continue;
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(root, entryPath, 'package.json'), 'utf8'));
    if (installed.version !== data.version) dependencyDrift.push({ path: entryPath, locked: data.version, installed: installed.version });
  } catch { dependencyDrift.push({ path: entryPath, missing: true }); }
}
const extraFiles = ['package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.github/workflows/docker.yml'];
const infrastructure = extraFiles.map(relative => ({ path: relative,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex') }));
const output = { capturedAt: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
  method: 'Local TypeScript AST call-site inventory plus manual call-chain review; rules are not vulnerability verdicts.',
  summary: { sourceFiles: inventory.length, testFiles: inventory.filter(f => f.test).length,
    otherSourceFiles: inventory.filter(f => !f.test).length, sourceBytes: inventory.reduce((n, f) => n + f.bytes, 0),
    dependencyEntries: Object.keys(lock.packages).length - 1, dependencyDrift: dependencyDrift.length },
  runtime: { node: process.version, execPath: process.execPath, versions: process.versions },
  inventory, infrastructure, dependencyDrift, credentialLiterals, sinks };
fs.writeFileSync(path.join(out, 'static-inventory.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ summary: output.summary, credentialLiterals, dependencyDrift }, null, 2));
