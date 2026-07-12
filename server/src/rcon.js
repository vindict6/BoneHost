import net from 'node:net';

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_AUTH_RESPONSE = 2;

function packet(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

/** Send one RCON command; resolves with the response body. */
export function rcon(host, port, password, command, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout: timeoutMs });
    let stage = 'auth';
    let acc = Buffer.alloc(0);
    let out = '';
    const fail = msg => { sock.destroy(); reject(new Error(msg)); };

    sock.on('timeout', () => fail('RCON timed out. Is the server running with FakeRcon installed?'));
    sock.on('error', e => fail(`RCON connection failed: ${e.code || e.message}`));
    sock.on('connect', () => sock.write(packet(1, SERVERDATA_AUTH, password)));

    sock.on('data', chunk => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 4) {
        const size = acc.readInt32LE(0);
        if (acc.length < 4 + size) break;
        const id = acc.readInt32LE(4);
        const type = acc.readInt32LE(8);
        const body = acc.slice(12, 2 + size).toString('utf8');
        acc = acc.slice(4 + size);

        if (stage === 'auth' && type === SERVERDATA_AUTH_RESPONSE) {
          if (id === -1) return fail('RCON password rejected.');
          stage = 'exec';
          sock.write(packet(2, SERVERDATA_EXECCOMMAND, command));
          // sentinel to detect end of multi-packet responses
          sock.write(packet(3, SERVERDATA_EXECCOMMAND, ''));
        } else if (stage === 'exec') {
          if (id === 3) { sock.end(); return resolve(out.trim()); }
          out += body;
        }
      }
    });
    sock.on('close', () => stage === 'exec' ? resolve(out.trim()) : undefined);
  });
}
