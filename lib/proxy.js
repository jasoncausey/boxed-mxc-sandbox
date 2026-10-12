// Forward proxy for a sandboxed program. MXC cannot filter loopback by port, so when a
// config asks for that, boxed denies the program all direct network access and points it
// here instead. Anything off this machine is forwarded unless the config turns that off;
// an address that belongs to this machine is forwarded only on the ports the config lists.

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
export async function startProxy({ loopbackPorts = [], external = 'allow', log = () => {} } = {}) {
  const allowed = new Set(loopbackPorts);
  const localOnly = external === 'deny';

  // The check and the connection use the same resolved addresses, so a name cannot
  // resolve to something harmless for the check and to this machine for the connection.
  async function dial(host, port) {
    const name = host.replace(/^\[|\]$/g, '');
    const literal = net.isIP(name.replace(/%.*$/, ''));
    // Looking a name up sends it to a DNS server, which is itself a way out, so with
    // external access off only names that resolve without the network are looked up.
    if (localOnly && !literal && !/^([^.]+\.)*localhost\.?$/i.test(name)) {
      throw new Refused(`${host} is not on this machine and boxed.proxy.external is "deny"`);
    }
    const addresses = literal
      ? [name]
      : (await dns.lookup(name, { all: true })).map((entry) => entry.address);
    if (localOnly && !addresses.every(isThisHost)) {
      throw new Refused(`${host} is not on this machine and boxed.proxy.external is "deny"`);
    }
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
