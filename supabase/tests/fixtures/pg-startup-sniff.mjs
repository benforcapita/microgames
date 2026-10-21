import net from 'node:net';

function makeErrorResponse(msg = 'rejected') {
  const fields = Buffer.from(`SFATAL\0C28000\0M${msg}\0\0`, 'utf8');
  const buf = Buffer.alloc(1 + 4 + fields.length);
  buf[0] = 0x45;
  buf.writeInt32BE(4 + fields.length, 1);
  fields.copy(buf, 5);
  return buf;
}

export async function startSniffServer() {
  const reports = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8) return;
      const len = buf.readInt32BE(0);
      if (buf.length < len) return;
      handled = true;
      if (len === 8 && buf.readInt32BE(4) === 0x04d2162f) {
        reports.push('SNIFF SSLRequest');
        process.stderr.write('SNIFF SSLRequest\n');
        socket.end(Buffer.from('N'), () => socket.destroy());
        return;
      }
      const keys = [];
      let offset = 8;
      while (offset < len) {
        const nextNullKey = buf.indexOf(0, offset);
        if (nextNullKey === -1 || nextNullKey === offset) break;
        const key = buf.toString('utf8', offset, nextNullKey);
        keys.push(key);
        offset = nextNullKey + 1;
        const nextNullVal = buf.indexOf(0, offset);
        if (nextNullVal === -1) break;
        offset = nextNullVal + 1;
      }
      const line = `SNIFF STARTUP ${keys.join(',')}`;
      reports.push(line);
      process.stderr.write(`${line}\n`);
      socket.end(makeErrorResponse(), () => socket.destroy());
    });
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  const close = async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  return { port, close, reports };
}
