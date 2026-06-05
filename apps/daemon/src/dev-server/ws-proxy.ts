// Lightweight WebSocket proxy: connect a client socket to a target
// WebSocket server and relay messages bidirectionally. Used by the
// dev-server proxy to forward Vite HMR WebSocket connections.
//
// Zero dependencies — uses only Node built-ins.

import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface WebSocketProxyTarget {
  hostname: string;
  port: number;
  path?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Upgrades the client socket to a WebSocket proxy connection with
 * the target dev server. Handles the WebSocket handshake upgrade
 * from the client and opens a corresponding connection to the target,
 * then relays frames bidirectionally.
 */
export function createWebSocketProxy(
  clientSocket: Socket,
  target: WebSocketProxyTarget,
): void {
  const clientKey = randomUUID().slice(0, 8);

  // Read the client's WebSocket upgrade request to extract headers
  // we need for the upstream connection.
  let clientBuf = '';
  let upgraded = false;

  clientSocket.on('data', (chunk: Buffer) => {
    if (upgraded) return;
    clientBuf += chunk.toString();

    // Wait for the full HTTP upgrade request (ends with \r\n\r\n).
    const headerEnd = clientBuf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;

    const headerStr = clientBuf.slice(0, headerEnd);
    const wsKey = extractHeader(headerStr, 'sec-websocket-key');
    const wsVersion = extractHeader(headerStr, 'sec-websocket-version') || '13';
    const wsProtocol = extractHeader(headerStr, 'sec-websocket-protocol');

    upgraded = true;

    // Open upstream WebSocket connection to the dev server.
    const upstream = createConnection(
      { host: target.hostname, port: target.port },
      () => {
        // Send the WebSocket upgrade request to upstream.
        const path = target.path || '/';
        const host = `${target.hostname}:${target.port}`;

        let upgradeReq = [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${wsKey || Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64').slice(0, 24)}`,
          `Sec-WebSocket-Version: ${wsVersion}`,
        ];

        if (wsProtocol) {
          upgradeReq.push(`Sec-WebSocket-Protocol: ${wsProtocol}`);
        }

        upgradeReq.push('\r\n');

        // Forward any additional headers from the client.
        for (const line of headerStr.split('\r\n').slice(1)) {
          const colonIdx = line.indexOf(':');
          if (colonIdx < 0) continue;
          const name = line.slice(0, colonIdx).trim().toLowerCase();
          if (['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'].includes(name)) continue;
          upgradeReq.push(line);
        }

        upgradeReq.push('\r\n');
        upstream.write(upgradeReq.join('\r\n'));
      },
    );

    let upstreamHandshake = false;
    let upstreamBuf = '';

    upstream.on('data', (chunk: Buffer) => {
      if (!upstreamHandshake) {
        upstreamBuf += chunk.toString();
        const endIdx = upstreamBuf.indexOf('\r\n\r\n');
        if (endIdx >= 0) {
          upstreamHandshake = true;

          // Parse the upstream response.
          const responseHeader = upstreamBuf.slice(0, endIdx);
          const statusLine = responseHeader.split('\r\n')[0] || '';
          const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);

          if (statusMatch && statusMatch[1] === '101') {
            // Send 101 Switching Protocols back to client.
            const acceptKey = extractHeader(responseHeader, 'sec-websocket-accept');
            const responseProtocol = extractHeader(responseHeader, 'sec-websocket-protocol');

            let response = [
              'HTTP/1.1 101 Switching Protocols',
              'Upgrade: websocket',
              'Connection: Upgrade',
              `Sec-WebSocket-Accept: ${acceptKey || ''}`,
            ];

            if (responseProtocol) {
              response.push(`Sec-WebSocket-Protocol: ${responseProtocol}`);
            }

            response.push('\r\n');
            clientSocket.write(response.join('\r\n'));

            // Relay any remaining bytes (frames after the handshake).
            const remaining = upstreamBuf.slice(endIdx + 4);
            if (remaining.length > 0) {
              clientSocket.write(remaining);
            }

            // Bidirectional relay of WebSocket frames.
            upstream.on('data', (data) => clientSocket.write(data));
            clientSocket.on('data', (data) => upstream.write(data));
          } else {
            // Upstream didn't upgrade — send 502 to client.
            clientSocket.write(
              'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nDev server did not upgrade to WebSocket.',
            );
            clientSocket.end();
            upstream.end();
          }
        }
        return;
      }

      // Post-handshake: relay frames.
      clientSocket.write(chunk);
    });

    // After handshake from client, relay any remaining client data.
    const remaining = clientBuf.slice(headerEnd + 4);
    const remainingBuf = Buffer.from(remaining, 'utf8');

    clientSocket.on('data', (chunk: Buffer) => {
      if (upstreamHandshake) {
        upstream.write(chunk);
      }
    });

    // If there's remaining data after the client's handshake (WebSocket
    // frames), buffer and send after upstream handshake completes.
    if (remainingBuf.length > 0) {
      const sendRemaining = () => {
        if (upstreamHandshake) {
          upstream.write(remainingBuf);
        } else {
          upstream.on('data', function wait() {
            upstream.removeListener('data', wait);
            upstream.write(remainingBuf);
          });
        }
      };
      sendRemaining();
    }

    upstream.on('error', (err) => {
      if (!upstreamHandshake) {
        clientSocket.write(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nDev server WebSocket error: ${err.message}`,
        );
      }
      clientSocket.end();
    });

    upstream.on('close', () => {
      clientSocket.end();
    });

    clientSocket.on('error', () => {
      upstream.end();
    });

    clientSocket.on('close', () => {
      upstream.end();
    });
  });

  // Timeout the handshake after 10s.
  const timeout = setTimeout(() => {
    if (!upgraded) {
      clientSocket.write(
        'HTTP/1.1 408 Request Timeout\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nWebSocket upgrade timeout.',
      );
      clientSocket.end();
    }
  }, 10_000);

  clientSocket.on('close', () => clearTimeout(timeout));
}

export function proxyWebSocketUpgrade(
  req: IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  target: WebSocketProxyTarget,
): void {
  const upstream = createConnection({ host: target.hostname, port: target.port }, () => {
    const path = target.path || '/';
    const host = `${target.hostname}:${target.port}`;
    const headers = req.headers;
    const upgradeReq = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${headers['sec-websocket-key'] || Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64').slice(0, 24)}`,
      `Sec-WebSocket-Version: ${headers['sec-websocket-version'] || '13'}`,
    ];

    const protocol = headers['sec-websocket-protocol'];
    if (typeof protocol === 'string' && protocol.length > 0) {
      upgradeReq.push(`Sec-WebSocket-Protocol: ${protocol}`);
    }

    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol'].includes(lower)) continue;
      if (Array.isArray(value)) {
        for (const item of value) upgradeReq.push(`${name}: ${item}`);
      } else if (typeof value === 'string') {
        upgradeReq.push(`${name}: ${value}`);
      }
    }

    upgradeReq.push('\r\n');
    upstream.write(upgradeReq.join('\r\n'));
    if (head.length > 0) upstream.write(head);
  });

  let upstreamHandshake = false;
  let upstreamBuf = Buffer.alloc(0);

  upstream.on('data', (chunk: Buffer) => {
    if (!upstreamHandshake) {
      upstreamBuf = Buffer.concat([upstreamBuf, chunk]);
      const headerEnd = upstreamBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = upstreamBuf.subarray(0, headerEnd).toString('utf8');
      if (!/^HTTP\/\d\.\d\s+101\b/.test(header)) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nDev server did not upgrade to WebSocket.');
        clientSocket.end();
        upstream.end();
        return;
      }
      upstreamHandshake = true;
      clientSocket.write(upstreamBuf);
      upstreamBuf = Buffer.alloc(0);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      return;
    }
    clientSocket.write(chunk);
  });

  upstream.on('error', (err) => {
    clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nDev server WebSocket error: ${err.message}`);
    clientSocket.end();
  });
  clientSocket.on('error', () => upstream.end());
  clientSocket.on('close', () => upstream.end());
  upstream.on('close', () => clientSocket.end());
}

function extractHeader(headerBlock: string, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const line of headerBlock.split('\r\n')) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    if (line.slice(0, sep).trim().toLowerCase() === lower) {
      return line.slice(sep + 1).trim();
    }
  }
  return undefined;
}