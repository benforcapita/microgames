import net from 'node:net';
import dns from 'node:dns';

net.Socket.prototype.connect = function (...args) {
  let host = 'localhost';
  if (typeof args[1] === 'string') {
    host = args[1];
  } else if (typeof args[0] === 'object' && args[0] !== null) {
    host = args[0].host || args[0].hostname || 'localhost';
  } else if (typeof args[0] === 'string') {
    host = args[0];
  }
  process.stderr.write(`CONNECT_ATTEMPT ${host}\n`);
  process.nextTick(() => {
    this.destroy(new Error('connect denied'));
  });
  return this;
};

dns.lookup = function (...args) {
  const host = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '');
  process.stderr.write(`DNS_LOOKUP ${host}\n`);
  const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
  if (cb) {
    process.nextTick(() => {
      const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
      err.code = 'ENOTFOUND';
      cb(err);
    });
  }
};

if (dns.promises && typeof dns.promises.lookup === 'function') {
  dns.promises.lookup = async function (...args) {
    const host = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '');
    process.stderr.write(`DNS_LOOKUP ${host}\n`);
    const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
    err.code = 'ENOTFOUND';
    throw err;
  };
}
