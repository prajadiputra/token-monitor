const asar = require('@electron/asar');
const fs = require('fs');
const path = '/Applications/Token Monitor.app/Contents/Resources/app.asar';

const tmpDir = '/tmp/asar-patch';
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

asar.extractAll(path, tmpDir);
console.log('Extracted OK');

// Copy updated nineRouterLimits
fs.cpSync('/Users/praja/token-monitor/src/shared/nineRouterLimits.js', tmpDir + '/src/shared/nineRouterLimits.js', { force: true });
console.log('Copied nineRouterLimits.js');

// Patch limits.js - add ninerouter to VALID_PROVIDERS
const limitsPath = tmpDir + '/src/shared/limits.js';
let limits = fs.readFileSync(limitsPath, 'utf8');
if (!limits.includes("'ninerouter'")) {
  limits = limits.replace("'ollama']", "'ollama', 'ninerouter']");
  fs.writeFileSync(limitsPath, limits);
  console.log('Patched limits.js');
}

// Patch credentialStore.js
const credPath = tmpDir + '/src/shared/credentialStore.js';
let cred = fs.readFileSync(credPath, 'utf8');
if (!cred.includes('ninerouter')) {
  cred = cred.replace(
    "'ollamaCookie': ['providers', 'ollama', 'cookie']",
    "'ollamaCookie': ['providers', 'ollama', 'cookie'],\n  ninerouterProfiles: ['providers', 'ninerouter', 'profiles']"
  );
  fs.writeFileSync(credPath, cred);
  console.log('Patched credentialStore');
}

// Patch limitCollector.js
const lcPath = tmpDir + '/src/shared/limitCollector.js';
let lc = fs.readFileSync(lcPath, 'utf8');
if (!lc.includes('nineRouterLimits')) {
  lc = lc.replace(
    "const kimiLimits = require('./kimiLimits');",
    "const kimiLimits = require('./kimiLimits');\nconst nineRouterLimits = require('./nineRouterLimits');"
  );
  lc = lc.replace("'kimi', 'ollama']", "'kimi', 'ollama', 'ninerouter']");
  lc = lc.replace(
    "kimi: (providerOptions, probeDeps) => kimiLimits.fetchKimiLimits(providerOptions, probeDeps),",
    "kimi: (providerOptions, probeDeps) => kimiLimits.fetchKimiLimits(providerOptions, probeDeps),\n    ninerouter: (providerOptions, probeDeps) => nineRouterLimits.fetchNineRouterLimits(providerOptions, probeDeps),"
  );
  fs.writeFileSync(lcPath, lc);
  console.log('Patched limitCollector');
}

// Repack
asar.createPackage(tmpDir, '/tmp/app.asar');
fs.cpSync('/tmp/app.asar', path, { force: true });
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('DONE - app.asar patched');
