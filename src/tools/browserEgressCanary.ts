// Dummy test service, used only by deploy/browser/docker-compose.test.yml.
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
const counts = { tcp: 0, http: 0, udp: 0 };
const service = createServer((_req, res) => { counts.http++; res.end('PRIVATE TEST CANARY'); });
service.on('connection', () => { counts.tcp++; });
service.on('upgrade', (_req, socket) => socket.destroy());
service.listen(8080, '0.0.0.0');
const udp = createSocket('udp4');
udp.on('message', () => { counts.udp++; });
udp.bind(3478, '0.0.0.0');
// Statistics use a separate port, so reading them cannot count as an attack.
createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(counts));
}).listen(8081, '0.0.0.0');
