// Throwaway spike proxy (T14). Not product code.
// HTTP CONNECT proxy: allows only the host:443 pairs given as arguments, logs one JSON line per
// request. Plain HTTP requests are always refused.
import http from 'node:http';
import net from 'node:net';

const allowed = new Set(process.argv.slice(2).map((h) => `${h}:443`));
const log = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const server = http.createServer((req, res) => {
  log({ decision: 'deny', reason: 'plain-http', method: req.method, url: req.url });
  res.writeHead(403).end();
});

server.on('connect', (req, clientSocket, head) => {
  const target = req.url ?? '';
  if (!allowed.has(target)) {
    log({ decision: 'deny', target });
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const [host, port] = target.split(':');
  const upstream = net.connect(Number(port), host, () => {
    log({ decision: 'allow', target });
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', (error) => {
    log({ decision: 'error', target, error: error.message });
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(3128, () => log({ event: 'listening', allowed: [...allowed] }));
