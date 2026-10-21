import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID, X509Certificate, createPrivateKey, createPublicKey} from 'node:crypto';
import {privateAddresses, privateIPv4} from './configuration.mjs';

function currentHost() {
  const name = process.platform === 'darwin'
    ? execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], {encoding: 'utf8', timeout: 2000}).trim()
    : os.hostname().replace(/\.local$/i, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(name)) throw new Error('This Mac needs a valid local network name');
  return name.toLowerCase() + '.local';
}

function privateDirectory(folder) {
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      process.getuid && stat.uid !== process.getuid()) throw new Error('Private Flyx connection folder required');
  return fs.realpathSync(folder);
}

function privateFile(file, root) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      process.getuid && stat.uid !== process.getuid() || path.dirname(fs.realpathSync(file)) !== root) {
    throw new Error('Private Flyx identity files required');
  }
}

export function inspectRemoteSetup({dataDir, host = currentHost(), addresses = privateAddresses(), now = Date.now()} = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.local$/i.test(host)) throw new Error('Invalid local Mac name');
  host = host.toLowerCase();
  const available = addresses.filter(privateIPv4);
  const folder = path.join(dataDir, 'remote'), file = path.join(folder, 'config.json');
  let previous, certificate, revision = '';
  if (fs.existsSync(folder)) {
    const root = privateDirectory(folder);
    if (fs.existsSync(file)) {
      privateFile(file, root);
      const bytes = fs.readFileSync(file);
      previous = JSON.parse(bytes);
      if (!Number.isSafeInteger(previous.port) || previous.port < 1024 || previous.port > 65535 ||
          !/^[a-z0-9][a-z0-9-]{0,62}\.local$/i.test(previous.host) || !privateIPv4(previous.bindAddress)) {
        throw new Error('Existing connection configuration is invalid');
      }
      privateFile(previous.certFile, root); privateFile(previous.keyFile, root);
      certificate = new X509Certificate(fs.readFileSync(previous.certFile));
      revision = createHash('sha256').update(bytes).update(certificate.raw).digest('hex');
    }
  }
  const bindAddress = available.includes(previous?.bindAddress) ? previous.bindAddress : available[0];
  const port = previous?.port ?? 3892;
  const replaceIdentity = !certificate || previous.host.toLowerCase() !== host || !certificate.checkHost(host) ||
    Date.parse(certificate.validTo) <= now || Date.parse(certificate.validFrom) > now;
  const needsSetup = replaceIdentity || previous?.bindAddress !== bindAddress;
  return {available: !!bindAddress, host, bindAddress, port, endpoint: `https://${host}:${port}`,
    previousEndpoint: previous ? `https://${previous.host.toLowerCase()}:${port}` : undefined,
    replaceIdentity, needsSetup, revision,
    status: !bindAddress ? 'offline' : !previous ? 'new' : replaceIdentity ? 'moved' : needsSetup ? 'network-changed' : 'ready'};
}

function generateIdentity(folder, {host, bindAddress}) {
  const config = path.join(folder, 'identity.cnf'), keyFile = path.join(folder, 'key.pem'), certFile = path.join(folder, 'cert.pem');
  fs.writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${host}\nO=Flyx Remote Local\n[ext]\nsubjectAltName=DNS:${host},IP:${bindAddress}\nbasicConstraints=critical,CA:TRUE,pathlen:0\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n`, {mode: 0o600, flag: 'wx'});
  execFileSync('/usr/bin/openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-x509', '-sha256', '-days', '365',
    '-config', config, '-keyout', keyFile, '-out', certFile], {stdio: 'ignore', timeout: 15000});
  fs.chmodSync(keyFile, 0o600); fs.chmodSync(certFile, 0o600);
  const cert = new X509Certificate(fs.readFileSync(certFile));
  const publicKey = createPublicKey(createPrivateKey(fs.readFileSync(keyFile))).export({type: 'spki', format: 'der'});
  if (!cert.checkHost(host) || !cert.publicKey.export({type: 'spki', format: 'der'}).equals(publicKey)) throw new Error('Generated identity validation failed');
  return {certFile, keyFile};
}

// Confirmation is mandatory and happens before any directory, key or config is created.
// The renderer cannot choose paths/hosts or supply a confirmation result.
export async function prepareRemoteSetup({dataDir, confirm, host, addresses, now,
  generate = generateIdentity, makeID = randomUUID} = {}) {
  const options = {dataDir, host, addresses, now};
  const plan = inspectRemoteSetup(options);
  if (!plan.available) throw new Error('Connect this Mac to your home network, then refresh');
  if (!plan.needsSetup) return {changed: false, restartRequired: false};
  if (typeof confirm !== 'function' || !await confirm(plan)) return {cancelled: true, changed: false};
  const fresh = inspectRemoteSetup(options);
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error('Connection settings changed; review setup again');
  const folder = path.join(dataDir, 'remote');
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, {mode: 0o700});
  const root = privateDirectory(folder), file = path.join(root, 'config.json');
  const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const id = makeID();
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error('Invalid setup identifier');
  const stage = fs.mkdtempSync(path.join(root, '.identity-'));
  fs.chmodSync(stage, 0o700);
  const created = []; let committed = false;
  try {
    let certFile = previous.certFile, keyFile = previous.keyFile;
    if (plan.replaceIdentity) {
      const identity = generate(stage, plan);
      certFile = path.join(root, `mac-identity-${id}-cert.pem`);
      keyFile = path.join(root, `mac-identity-${id}-key.pem`);
      for (const [source, destination] of [[identity.certFile, certFile], [identity.keyFile, keyFile]]) {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); created.push(destination); fs.chmodSync(destination, 0o600);
      }
    }
    if (fs.existsSync(file)) {
      const backup = path.join(root, `config-before-${id}.json`);
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); fs.chmodSync(backup, 0o600);
    }
    const next = {...previous, host: plan.host, bindAddress: plan.bindAddress, port: plan.port,
      endpoint: plan.endpoint, certFile, keyFile, enabled: true};
    const temporary = path.join(stage, 'config.json');
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    fs.renameSync(temporary, file); committed = true;
    // devices.json, accounts, downloads and previous identity files are deliberately untouched.
    return {changed: true, restartRequired: true};
  } finally {
    if (!committed) for (const file of created) fs.unlinkSync(file);
    fs.rmSync(stage, {recursive: true, force: true});
  }
}
