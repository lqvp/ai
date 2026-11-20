import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import urlToBase64, { assertNotLocalAddress } from '../src/utils/url2base64.js';

let server: http.Server;
let url = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.setHeader('content-type', 'text/plain');
      res.end('hello');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') {
    throw new Error('failed to bind test server');
  }
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

describe('urlToBase64', () => {
  it('returns a real base64 string', async () => {
    const encoded = await urlToBase64(`${url}/ok`, {
      allowLocalAddress: true,
    });
    expect(encoded).toBe(Buffer.from('hello').toString('base64'));
    expect(encoded).not.toContain(',');
  });

  it('rejects on HTTP errors', async () => {
    await expect(
      urlToBase64(`${url}/missing`, { allowLocalAddress: true })
    ).rejects.toBeTruthy();
  });

  it('rejects local addresses by default', () => {
    expect(() => assertNotLocalAddress(`${url}/ok`)).toThrow(/local address/);
    expect(() => assertNotLocalAddress('http://localhost/image.png')).toThrow(
      /local address/
    );
    expect(() => assertNotLocalAddress('http://127.0.0.1:3000/file')).toThrow(
      /local address/
    );
    expect(() => assertNotLocalAddress('http://[::1]/file')).toThrow(
      /local address/
    );
    expect(() => assertNotLocalAddress('http://0.0.0.0/file')).toThrow(
      /local address/
    );
    expect(() => assertNotLocalAddress('http://169.254.169.254/file')).toThrow(
      /local address/
    );
    expect(() => assertNotLocalAddress('http://localhost./file')).toThrow(
      /local address/
    );
    expect(() => assertNotLocalAddress('http://127.0.0.1./file')).toThrow(
      /local address/
    );
    expect(() =>
      assertNotLocalAddress('http://[::ffff:127.0.0.1]/file')
    ).toThrow(/local address/);
    expect(() => assertNotLocalAddress('http://[::ffff:7f00:1]/file')).toThrow(
      /local address/
    );
    expect(() => assertNotLocalAddress('http://[fe80::1]/file')).toThrow(
      /local address/
    );
  });

  it('allows public and RFC1918 addresses', () => {
    expect(() =>
      assertNotLocalAddress('http://example.com/image.png')
    ).not.toThrow();
    expect(() =>
      assertNotLocalAddress('http://192.168.1.10/image.png')
    ).not.toThrow();
    expect(() =>
      assertNotLocalAddress('http://10.0.0.5/image.png')
    ).not.toThrow();
    expect(() =>
      assertNotLocalAddress('http://172.16.0.1/image.png')
    ).not.toThrow();
  });
});
