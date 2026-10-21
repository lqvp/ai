import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import urlToBase64 from '../src/utils/url2base64.js';

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
    const encoded = await urlToBase64(`${url}/ok`);
    expect(encoded).toBe(Buffer.from('hello').toString('base64'));
    expect(encoded).not.toContain(',');
  });

  it('rejects on HTTP errors', async () => {
    await expect(urlToBase64(`${url}/missing`)).rejects.toBeTruthy();
  });
});
