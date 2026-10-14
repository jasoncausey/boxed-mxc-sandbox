// Tests for lib/proxy.js. DNS is stubbed, so nothing here leaves this machine: every name
// "resolves" to 127.0.0.1, as a name under a zone the sandboxed program controls could.

import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

import { parseHostRule, startProxy } from '../lib/proxy.js';

describe('parseHostRule', () => {
  test('accepts names, wildcards, ports and IP addresses in canonical form', () => {
    assert.deepEqual(parseHostRule('Example.COM.'), { host: 'example.com', port: null, wildcard: false });
    assert.deepEqual(parseHostRule('*.example.com'), { host: 'example.com', port: null, wildcard: true });
    assert.deepEqual(parseHostRule('registry.npmjs.org:443'), { host: 'registry.npmjs.org', port: 443, wildcard: false });
    assert.deepEqual(parseHostRule('[::1]:8080'), { host: '::1', port: 8080, wildcard: false });
    assert.deepEqual(parseHostRule('::1'), { host: '::1', port: null, wildcard: false });
    assert.deepEqual(parseHostRule('127.1'), { host: '127.0.0.1', port: null, wildcard: false });
  });

  test('rejects anything new URL() would cut short instead of truncating it', () => {
    for (const rule of ['example.com#junk', 'example.com?', 'exa\\mple.com', 'a@example.com',
      'example.com/path', 'exa%2emple.com', 'example .com', '', '*.', 'a.*.com', '*.1.2.3.4', '[example.com]',
      'example.com:0', 'a:b:80']) {
      assert.throws(() => parseHostRule(rule), undefined, `accepted ${JSON.stringify(rule)}`);
    }
  });
});

describe('proxy host rules', () => {
  const realLookup = dns.lookup;
  let lookups;
  let target;
  let echo;
  let proxy;
  let proxyPort;

  before(async () => {
    dns.lookup = async (name, options) => {
      lookups.push(name);
      return options?.all ? [{ address: '127.0.0.1', family: 4 }] : { address: '127.0.0.1', family: 4 };
    };
    target = net.createServer((socket) => socket.end());
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
    // Answers with the Host header it was sent.
    echo = http.createServer((req, res) => res.end(req.headers.host));
    await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
    proxy = await startProxy({
      external: 'deny', loopbackPorts: [target.address().port, echo.address().port],
      allowHosts: ['example.com', '*.allowed.test'], denyHosts: ['blocked.allowed.test'],
    });
    proxyPort = Number(new URL(proxy.url).port);
  });

  after(() => {
    dns.lookup = realLookup;
    proxy.close();
    target.close();
    echo.close();
  });

  beforeEach(() => { lookups = []; });

  function connect(host) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(`CONNECT ${host}:${target.address().port} HTTP/1.1\r\nHost: x\r\n\r\n`);
      });
      let reply = '';
      socket.on('data', (chunk) => { reply += chunk; });
      socket.on('close', () => resolve(reply.split('\r\n')[0]));
      socket.on('error', reject);
    });
  }

  test('reaches an allowed host, looked up by the name that was checked', async () => {
    assert.equal(await connect('Example.COM'), 'HTTP/1.1 200 Connection Established');
    assert.deepEqual(lookups, ['example.com']);
    assert.equal(await connect('api.allowed.test'), 'HTTP/1.1 200 Connection Established');
  });

  test('refuses a host outside allowHosts without looking it up', async () => {
    assert.equal(await connect('evil.test'), 'HTTP/1.1 403 Forbidden');
    assert.equal(await connect('allowed.test'), 'HTTP/1.1 403 Forbidden');
    assert.deepEqual(lookups, []);
  });

  test('denyHosts wins over allowHosts', async () => {
    assert.equal(await connect('BLOCKED.allowed.test.'), 'HTTP/1.1 403 Forbidden');
    assert.deepEqual(lookups, []);
  });

  // new URL() reads each of these as example.com, but DNS would look up the whole name
  // under evil.test, whose server picks the address.
  for (const host of ['example.com?.evil.test', 'example.com/.evil.test', 'example.com#.evil.test',
    'example.com\\.evil.test', 'x@example.com', 'example.com%2fevil.test', 'example.com:1@evil.test']) {
    test(`refuses smuggled CONNECT target ${JSON.stringify(host)}`, async () => {
      assert.notEqual(await connect(host), 'HTTP/1.1 200 Connection Established');
      assert.deepEqual(lookups, [], 'the name went to DNS');
    });
  }

  test('sends a plain HTTP request with the checked host as its Host header', async () => {
    const port = echo.address().port;
    const body = await new Promise((resolve, reject) => {
      http.get({
        host: '127.0.0.1', port: proxyPort, path: `http://example.com:${port}/`,
        headers: { host: 'evil.test' }, agent: false,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(`${res.statusCode} ${data}`));
      }).on('error', reject);
    });
    assert.equal(body, `200 example.com:${port}`);
  });
});
