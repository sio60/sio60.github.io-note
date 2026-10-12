import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Only web/ is uploaded to Pages. Validate the actual public artifact.
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const errors = [];
const textExtensions = new Set(['.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.svg', '.txt', '.xml', '.map', '.yaml', '.yml']);
let checkedReferences = 0;
let configState = 'No cloud configuration file; database connectivity is not checked.';

function report(file, message) {
  errors.push(`${path.relative(webRoot, file) || '.'}: ${message}`);
}

async function walk(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, item.name);
    if (item.isSymbolicLink()) {
      report(fullPath, 'Symbolic links are not allowed in the public artifact.');
    } else if (item.isDirectory()) {
      files.push(...await walk(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function checkReference(file, reference) {
  const value = reference.trim();
  if (!value || value.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return;
  if (value.includes('${')) return; // Runtime URLs need a browser check.
  if (value.startsWith('/')) {
    report(file, `Root-relative URL will bypass this repository's Pages path: ${value}`);
    return;
  }
  let localPath;
  try {
    localPath = decodeURIComponent(value.split(/[?#]/, 1)[0]);
  } catch {
    report(file, `Invalid URL encoding: ${value}`);
    return;
  }
  if (!localPath) return;
  const target = path.resolve(path.dirname(file), localPath);
  const relative = path.relative(webRoot, target);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    report(file, `Reference leaves the public directory: ${value}`);
    return;
  }
  try {
    const targetStat = await stat(target);
    if (targetStat.isDirectory()) await stat(path.join(target, 'index.html'));
    checkedReferences += 1;
  } catch {
    report(file, `Missing local file: ${value}`);
  }
}

function checkSecrets(file, content) {
  if (/sb_secret_[A-Za-z0-9_-]+/.test(content)) {
    report(file, 'A Supabase secret key is present. Use a publishable key in the browser.');
  }
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(content)) {
    report(file, 'A private key is present.');
  }
  if (/(?:postgres|postgresql):\/\/[^\s"'`]+:[^\s"'`]+@/i.test(content)) {
    report(file, 'A database connection string with credentials is present.');
  }
  // Legacy Supabase anon keys are public JWTs; service_role and user JWTs are not.
  for (const match of content.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g)) {
    try {
      const payload = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8'));
      if (payload.role !== 'anon') report(file, 'A non-anon JWT is present in a public file.');
    } catch {
      report(file, 'An unreadable JWT-like credential is present in a public file.');
    }
  }
}

function checkConfig(file, content) {
  try {
    const context = vm.createContext({ window: {} }, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(content, context, { timeout: 100, filename: 'config.js' });
    const config = context.window.CURSE_CONFIG;
    if (!config || typeof config.supabaseUrl !== 'string' || typeof config.publishableKey !== 'string') {
      report(file, 'Set window.CURSE_CONFIG with string supabaseUrl and publishableKey values.');
      return;
    }
    const url = config.supabaseUrl.trim();
    const key = config.publishableKey.trim();
    if (!url && !key) {
      configState = 'Cloud configuration is empty; the site uses browser storage.';
      return;
    }
    if (!url || !key) {
      report(file, 'supabaseUrl and publishableKey must either both be empty or both be set.');
      return;
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      report(file, 'supabaseUrl must be an HTTPS project URL without credentials, query, or fragment.');
    }
    let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
    if (!publicKey) {
      try {
        publicKey = key.split('.').length === 3 && JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role === 'anon';
      } catch {
        publicKey = false;
      }
    }
    if (!publicKey) report(file, 'publishableKey must be a Supabase publishable key or legacy anon JWT.');
    configState = 'Cloud configuration is present; verify remote storage in a browser.';
  } catch {
    report(file, 'config.js could not be read as a valid browser configuration.');
  }
}

const files = await walk(webRoot);
if (!files.includes(path.join(webRoot, 'index.html'))) report(webRoot, 'index.html is missing.');

for (const file of files) {
  const name = path.basename(file);
  if (/^\.env(?:\.|$)|\.(?:pem|p12|pfx|key)$/i.test(name)) {
    report(file, 'A credential file is inside the public artifact.');
  }
  if (!textExtensions.has(path.extname(file))) continue;
  const content = await readFile(file, 'utf8');
  checkSecrets(file, content);
  if (file === path.join(webRoot, 'config.js')) checkConfig(file, content);
  const references = new Set();
  if (/\.(?:html|svg)$/.test(file)) {
    for (const match of content.matchAll(/\b(?:src|href|poster)\s*=\s*(["'])(.*?)\1/gs)) references.add(match[2]);
  }
  if (/\.(?:css|html)$/.test(file)) {
    for (const match of content.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)/gs)) references.add(match[2] ?? match[3]);
  }
  if (/\.(?:js|mjs)$/.test(file)) {
    // Static imports, worker registration, and cache asset lists use local strings.
    for (const match of content.matchAll(/(["'])(\.{1,2}\/[^"'\r\n]*)\1/g)) references.add(match[2]);
  }
  if (file.endsWith('.webmanifest')) {
    try {
      const manifest = JSON.parse(content);
      for (const key of ['start_url', 'scope']) if (typeof manifest[key] === 'string') references.add(manifest[key]);
      for (const item of [...(manifest.icons ?? []), ...(manifest.screenshots ?? [])]) if (item.src) references.add(item.src);
    } catch {
      report(file, 'The web app manifest is not valid JSON.');
    }
  }
  for (const reference of references) await checkReference(file, reference);
}

if (errors.length) {
  console.error(`Site validation failed (${errors.length}):\n${errors.map(message => `- ${message}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Site validation passed: ${files.length} public files, ${checkedReferences} local references, no detected private credentials.`);
  console.log(configState);
  console.log('This static check does not prove that the remote database is connected.');
}
