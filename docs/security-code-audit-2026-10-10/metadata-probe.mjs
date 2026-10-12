// Exact source functions run with in-memory substitutes for all process/file operations.
// No PID is signalled, no actual metadata is changed, and no Linux host is required.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const root = process.cwd();
const out = path.join(root, 'docs/security-code-audit-2026-10-10');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const sourcePath = 'src/utils/playwrightClient.ts';
const source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
const syntax = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const names = ['normalizeBrowserDomainMetadata', 'cleanupStaleLocalBrowserSessions', 'createForceKill'];
const nodes = names.map(name => syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name));
if (nodes.some(node => !node)) throw new Error('Audited function was not found');
const functions = ts.transpileModule(nodes.map(node => node.getText(syntax)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const signals = [], cleanupPaths = [], commands = [];
const state = {
  staleBrowserCleanupPerformed: false,
  process: { platform: 'linux', pid: 123456, kill: pid => { signals.push(pid); } },
  shouldTrackLocalBrowserSessionClients: () => true,
  normalizeActiveClientPids: pids => pids,
  writeBrowserDomainMetadata: () => {},
  listBrowserDomainMetadataEntries: () => [{ domainHash: 'deadbeef', metadataPath: 'AUDIT_METADATA', sessionMode: 'headless' }],
  getBrowserDomainLockFilePathByHash: () => 'AUDIT_LOCK',
  acquireNativeFileLock: () => ({ release() {} }),
  readBrowserDomainMetadataFromPath: () => state.fixtureMetadata,
  resolveLocalBrowserCandidatePid: () => null,
  clearBrowserDomainMetadataFromPath: () => {},
  isProcessInspectionTimeoutError: () => false,
  cleanupStaleProfileLocks: target => { cleanupPaths.push(target); },
  clearBrowserDomainMetadata: () => {}, rmSync: () => {}, execFileSync: (command, args) => { commands.push({ command, args }); },
};
const context = vm.createContext(state);
vm.runInContext(functions, context, { timeout: 1000 });
vm.runInContext("fixtureMetadata = normalizeBrowserDomainMetadata({ browserPid: -1, tempDir: 'AUDIT_UNVALIDATED_PATH', clientPids: [] }, 'headless'); cleanupStaleLocalBrowserSessions();", context, { timeout: 1000 });
const acceptedNegativePid = state.fixtureMetadata.browserPid;
state.staleBrowserCleanupPerformed = false;
state.process.platform = 'win32';
vm.runInContext("fixtureMetadata = normalizeBrowserDomainMetadata({ browserPid: 424242, tempDir: 'AUDIT_STALE_PROFILE', clientPids: [] }, 'headless'); cleanupStaleLocalBrowserSessions();", context, { timeout: 1000 });
const result = { method: 'Exact audited source functions in a VM with mocked Linux process and filesystem operations; not a cross-user integration exploit.',
  sourcePath, sourceLines: nodes.map(node => ({ name: node.name.text, line: syntax.getLineAndCharacterOfPosition(node.getStart()).line + 1 })),
  acceptedNegativePid, matchingBrowserFound: false,
  wouldSignalPidsOnLinux: signals, wouldExecuteOnWindows: commands,
  wouldCleanProfilePaths: cleanupPaths, actualProcessesSignalled: 0, actualFilesDeleted: 0 };
fs.writeFileSync(path.join(out, 'metadata-probe.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
