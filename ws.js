// Minimal, dependency-free WebSocket server (RFC 6455) — enough for a game.
'use strict';
const crypto = require('crypto');
const EventEmitter = require('events');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1 << 20; // 1 MB
const MAX_BUFFERED = 768 * 1024; // drop "volatile" messages to slow clients

class WSConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.open = true;
    this.alive = true;
    this._didClose = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    socket.on('end', () => this._closed());
  }
  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.open) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) !== 0) return this.close(1009);
        len = this.buf.readUInt32BE(6); off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4); off += 4;
      }
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + len);
      this._frame(fin, op, payload);
    }
  }
  _frame(fin, op, p) {
    if (op === 0x8) return this.close();
    if (op === 0x9) return this._send(0xA, p);
    if (op === 0xA) { this.alive = true; return; }
    this.alive = true;
    if (op === 0x1 || op === 0x2) {
      if (fin) this.emit('message', p.toString('utf8'));
      else this.frag = [p];
      return;
    }
    if (op === 0x0 && this.frag) {
      this.frag.push(p);
      if (fin) { const m = Buffer.concat(this.frag); this.frag = null; this.emit('message', m.toString('utf8')); }
    }
  }
  _send(op, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
    h[0] = 0x80 | op;
    try { this.socket.write(Buffer.concat([h, payload])); } catch (e) { this._closed(); }
  }
  send(str) { this._send(0x1, Buffer.from(str, 'utf8')); }
  // Skip if the client is falling behind (used for snapshots that will be superseded anyway)
  sendVolatile(str) { if (this.socket.writableLength < MAX_BUFFERED) this.send(str); }
  ping() { this._send(0x9, Buffer.alloc(0)); }
  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code);
    this._send(0x8, b);
    this.open = false;
    try { this.socket.end(); } catch (e) { /* ignore */ }
    this._closed();
  }
  _closed() {
    if (this._didClose) return;
    this._didClose = true;
    this.open = false;
    this.emit('close');
    setTimeout(() => { try { this.socket.destroy(); } catch (e) { /* ignore */ } }, 1000);
  }
}

function attach(server, onConnection) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    onConnection(new WSConn(socket), req);
  });
}

module.exports = { attach };
