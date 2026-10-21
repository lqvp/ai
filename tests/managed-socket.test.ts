import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ManagedSocket } from '../src/modules/earthquake_warning/socket.js';

let wss: WebSocketServer;
let url: string;

beforeAll(async () => {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));

  wss.on('connection', (socket) => {
    socket.send('hello');
  });

  const { port } = wss.address() as AddressInfo;
  url = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe('ManagedSocket', () => {
  it('connects, receives messages and closes', async () => {
    const messages: string[] = [];

    const socket = new ManagedSocket({
      url,
      label: 'test',
      log: () => {},
      maxReconnectAttempts: 1,
      reconnectDelay: 10,
      maxReconnectDelay: 20,
      onOpen: () => {},
      onMessage: (data) => messages.push(data.toString()),
      onError: () => {},
      onClose: () => {},
    });

    socket.connect();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for message')),
        2000
      );
      const interval = setInterval(() => {
        if (messages.length > 0) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 10);
    });

    expect(messages[0]).toBe('hello');
    expect(socket.isOpen()).toBe(true);

    socket.close();
    expect(socket.isOpen()).toBe(false);
  });
});
