import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import APIClient from '../src/api/APIClient.js';
import { initConfig, resolveConfig } from '../src/config.js';

let server: http.Server;
let baseUrl: string;
let lastBody = '';
let lastPath = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      lastPath = req.url ?? '';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'file-1', createdNote: { id: 'note-1' } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  initConfig(
    resolveConfig({
      host: baseUrl,
      i: 'token',
      postNotPublic: true,
    })
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('APIClient', () => {
  it('uploads multipart form data with the global FormData/File', async () => {
    const client = new APIClient();
    const result = (await client.upload(Buffer.from('hello'), {
      filename: 'a.txt',
      contentType: 'text/plain',
    })) as { id: string };

    expect(result.id).toBe('file-1');
    expect(lastPath).toBe('/api/drive/files/create');
    expect(lastBody).toContain('name="i"');
    expect(lastBody).toContain('filename="a.txt"');
    expect(lastBody).toContain('hello');
  });

  it('does not mutate the caller parameter in post()', async () => {
    const client = new APIClient();
    const param = { text: 'hi' };

    await client.post(param);

    expect(param).toEqual({ text: 'hi' });
    expect(lastBody).toContain('"visibility":"home"');
  });
});
