// Forward proxy for a sandboxed program. MXC cannot filter loopback by port, so when a
// config asks for that, boxed denies the program all direct network access and points it
// here instead. Anything off this machine is forwarded unless the config turns that off;
// an address that belongs to this machine is forwarded only on the ports the config lists.
// Host rules narrow this further: denyHosts are always refused, and once allowHosts is
// given, nothing else off this machine is forwarded.

import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

class Refused extends Error {}

// A service bound to every interface answers on the machine's LAN addresses as well as
// on 127.0.0.1, so those count as this machine too.
function isThisHost(address) {
  const ip = address.replace(/%.*$/, '');
  const family = net.isIPv6(ip) ? 'ipv6' : 'ipv4';
  const local = new net.BlockList();
  local.addSubnet('127.0.0.0', 8);
  local.addSubnet('0.0.0.0', 8);
  local.addAddress('::1', 'ipv6');
  local.addAddress('::', 'ipv6');
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    local.addAddress(iface.address.replace(/%.*$/, ''), iface.family === 'IPv6' ? 'ipv6' : 'ipv4');
  }
  return local.check(ip, family);
}

// The form a host takes for matching and for looking up: lower case, IDN in punycode,
// IPv4 and IPv6 in their usual spelling, no brackets. Null if it is not a host at all.
// new URL() reads "a.com?.b.net" as a.com, while DNS looks up all of it under b.net, so
// anything URL would take as the end of the host is refused rather than cut off.
function canonicalHost(host) {
  const name = host.replace(/^\[(.*)\]$/, '$1');
  if (net.isIPv6(name.replace(/%.*$/, ''))) {
    try { return new URL(`http://[${name}]`).hostname.slice(1, -1); } catch { return name.toLowerCase(); }
  }
  if (!name || /[\x00-\x20\x7f/?#@\\:%[\]]/.test(name)) return null;
  try { return new URL(`http://${name}`).hostname; } catch { return null; }
}

// A rule is a host name or IP address, optionally followed by :PORT; an IPv6 address
// with a port goes in brackets. "*.example.com" matches every name under example.com
// but not example.com itself. Throws on anything else.
export function parseHostRule(text) {
  if (typeof text !== 'string') throw new Error(`${JSON.stringify(text)} is not a host`);
  let host = text;
  let port = null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed) [, host, port = null] = bracketed;
  else if (!net.isIPv6(text)) {
    const withPort = /^(.*):(\d+)$/.exec(text);
    if (withPort) [, host, port] = withPort;
  }
  if (port !== null) {
    port = Number(port);
    if (!(port >= 1 && port <= 65535)) throw new Error(`${JSON.stringify(text)} has an invalid port`);
  }
  const wildcard = host.startsWith('*.');
  if (wildcard) host = host.slice(2);
  const canonical = host.includes('*') || (bracketed && !net.isIPv6(host)) ? null : canonicalHost(host);
  if (!canonical) throw new Error(`${JSON.stringify(text)} is not a host name, IP address or *.domain`);
  host = canonical.replace(/\.$/, '');
  if (wildcard && net.isIP(host)) throw new Error(`${JSON.stringify(text)}: "*." needs a domain name`);
  return { host, port, wildcard };
}

function matchesAny(rules, name, port) {
  return rules.some((rule) => (rule.port === null || rule.port === port) &&
    (rule.wildcard ? name.endsWith(`.${rule.host}`) : name === rule.host));
}

function connect(address, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    // Stays attached for the life of the socket: an unhandled 'error' would take boxed
    // down and leave the sandboxed program running without it.
    socket.on('error', (error) => { socket.destroy(); reject(error); });
    socket.once('connect', () => resolve(socket));
  });
}

// Resolves once the proxy is listening. log, if given, is called for each refused request.
export async function startProxy({
  loopbackPorts = [], external = 'allow', allowHosts = [], denyHosts = [], log = () => {},
} = {}) {
  const allowed = new Set(loopbackPorts);
  const allowRules = allowHosts.map(parseHostRule);
  const denyRules = denyHosts.map(parseHostRule);

  // The check and the connection use the same resolved addresses, so a name cannot
  // resolve to something harmless for the check and to this machine for the connection.
  // The rules are matched against the same name that is looked up, for the same reason.
  async function dial(host, port) {
    const name = canonicalHost(host);
    if (name === null) throw new Refused(`${JSON.stringify(host)} is not a valid host name`);
    const literal = net.isIP(name.replace(/%.*$/, ''));
    const canonical = name.replace(/\.$/, '');
    if (matchesAny(denyRules, canonical, port)) {
      throw new Refused(`${host}:${port} matches boxed.proxy.denyHosts`);
    }
    // A host in allowHosts may leave this machine whatever "external" says. Any other
    // host may only when "external" is "allow" and there is no allowHosts list.
    const localOnly = allowRules.length
      ? !matchesAny(allowRules, canonical, port)
      : external === 'deny';
    const why = allowRules.length
      ? `${host}:${port} is not in boxed.proxy.allowHosts`
      : `${host} is not on this machine and boxed.proxy.external is "deny"`;
    // Looking a name up sends it to a DNS server, which is itself a way out, so with
    // external access off only names that resolve without the network are looked up.
    if (localOnly && !literal && !/^([^.]+\.)*localhost\.?$/i.test(name)) throw new Refused(why);
    const addresses = literal
      ? [name]
      : (await dns.lookup(name, { all: true })).map((entry) => entry.address);
    if (localOnly && !addresses.every(isThisHost)) throw new Refused(why);
    if (!allowed.has(port) && addresses.some(isThisHost)) {
      throw new Refused(`${host}:${port} is on this machine and port ${port} is not in boxed.proxy.loopbackPorts`);
    }
    let failure = new Error(`no address for ${host}`);
    for (const address of addresses) {
      try { return await connect(address, port); } catch (error) { failure = error; }
    }
    throw failure;
  }

  function status(error, target) {
    if (!(error instanceof Refused)) return [502, `boxed proxy: cannot reach ${target}: ${error.message}\n`];
    log(`proxy refused ${target}`);
    return [403, `boxed proxy: ${error.message}\n`];
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url); } catch { /* not an absolute URL */ }
    if (url?.protocol !== 'http:') {
      res.writeHead(400).end('boxed proxy: only absolute http:// URLs and CONNECT are supported\n');
      return;
    }
    let socket;
    try {
      socket = await dial(url.hostname, Number(url.port || 80));
    } catch (error) {
      const [code, body] = status(error, url.host);
      res.writeHead(code).end(body);
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    // No agent: one would open its own connection and ignore the vetted socket. host and
    // port name that same socket's peer, so nothing here can reach a different address.
    const upstream = http.request({
      createConnection: () => socket, host: socket.remoteAddress, port: socket.remotePort,
      setHost: false, method: req.method, path: url.pathname + url.search, headers,
    }, (reply) => {
      res.writeHead(reply.statusCode, reply.statusMessage, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connect', async (req, client, head) => {
    client.on('error', () => client.destroy());
    const match = /^(.+):(\d+)$/.exec(req.url);
    let upstream;
    try {
      if (!match) throw new Refused(`malformed CONNECT target ${req.url}`);
      upstream = await dial(match[1], Number(match[2]));
    } catch (error) {
      const [code, body] = status(error, req.url);
      client.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return;
    }
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });

  server.on('clientError', (error, socket) => socket.destroy());
  // Model responses stream for a long time and uploads can be slow.
  server.requestTimeout = 0;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.close(); server.closeAllConnections(); },
  };
}
