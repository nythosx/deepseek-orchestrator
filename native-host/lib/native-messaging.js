// Chrome native messaging framing: each message is a UTF-8 JSON blob prefixed
// by its length as a 4-byte little-endian unsigned integer.
const { EventEmitter } = require('events');

class NativeMessaging extends EventEmitter {
  constructor(input, output) {
    super();
    this.input = input;
    this.output = output;
    this._buffer = Buffer.alloc(0);
    this.input.on('data', (chunk) => this._onData(chunk));
    this.input.on('end', () => this.emit('close'));
    this.input.on('error', (err) => this.emit('error', err));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (true) {
      if (this._buffer.length < 4) return;
      const length = this._buffer.readUInt32LE(0);
      if (this._buffer.length < 4 + length) return;
      const body = this._buffer.slice(4, 4 + length);
      this._buffer = this._buffer.slice(4 + length);
      try {
        const msg = JSON.parse(body.toString('utf8'));
        this.emit('message', msg);
      } catch (err) {
        this.emit('error', new Error(`Failed to parse native message: ${err.message}`));
      }
    }
  }

  send(obj) {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    this.output.write(Buffer.concat([header, json]));
  }
}

module.exports = { NativeMessaging };
