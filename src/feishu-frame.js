// pbbp2 Frame, ported from node-sdk 1.76.0. uint64 IDs stay BigInt so ACKs
// preserve all 64 bits. No generated schema/runtime or Number rounding.
const varint = value => {
  const integer = value && typeof value === 'object' && 'low' in value && 'high' in value ?
    (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0) : BigInt(value ?? 0);
  let n = BigInt.asUintN(64, integer);
  const bytes = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
};
const field = (id, bytes) => Buffer.concat([varint(id * 8 + 2), varint(bytes.length), bytes]);
export function encodeFrame(frame) {
  const parts = [Buffer.from([8]), varint(frame.SeqID), Buffer.from([16]), varint(frame.LogID),
    Buffer.from([24]), varint(frame.service), Buffer.from([32]), varint(frame.method)];
  for (const h of frame.headers ?? []) parts.push(field(5, Buffer.concat([field(1, Buffer.from(h.key)), field(2, Buffer.from(h.value))])));
  for (const [id, name, alias] of [[6, 'payloadEncoding', 'payload_encoding'], [7, 'payloadType', 'payload_type'], [8, 'payload'], [9, 'LogIDNew']]) {
    const value = frame[name] ?? frame[alias];
    if (value != null) parts.push(field(id, Buffer.from(value)));
  }
  return Buffer.concat(parts);
}
function readFields(bytes, visit) {
  let offset = 0;
  const take = length => {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) throw new Error('Truncated protobuf');
    const value = bytes.subarray(offset, offset + length); offset += length; return value;
  };
  const read = () => {
    let n = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const b = take(1)[0];
      if (shift === 63n && b > 1) throw new Error('Invalid varint');
      n |= BigInt(b & 127) << shift;
      if (!(b & 128)) return n;
    }
    throw new Error('Invalid varint');
  };
  while (offset < bytes.length) {
    const tag = Number(read()), id = tag >>> 3, wire = tag & 7;
    if (!id) throw new Error('Invalid protobuf field');
    if (wire === 0) visit(id, wire, read());
    else if (wire === 2) visit(id, wire, take(Number(read())));
    else if (wire === 1) take(8);
    else if (wire === 5) take(4);
    else throw new Error('Unsupported protobuf wire type');
  }
}
export function decodeFrame(input) {
  const bytes = Buffer.from(input), frame = { headers: [] };
  readFields(bytes, (id, wire, value) => {
    if (id <= 4) {
      if (wire !== 0) throw new Error('Invalid frame integer');
      frame[{ 1: 'SeqID', 2: 'LogID', 3: 'service', 4: 'method' }[id]] = id <= 2 ? value : Number(BigInt.asIntN(32, value));
    } else if (id <= 9) {
      if (wire !== 2) throw new Error('Invalid frame bytes');
      if (id === 5) {
        const h = {};
        readFields(value, (key, type, text) => {
          if (key === 1 || key === 2) {
            if (type !== 2) throw new Error('Invalid header');
            h[key === 1 ? 'key' : 'value'] = text.toString('utf8');
          }
        });
        if (h.key === undefined || h.value === undefined) throw new Error('Incomplete header');
        frame.headers.push(h);
      } else frame[{ 6: 'payloadEncoding', 7: 'payloadType', 8: 'payload', 9: 'LogIDNew' }[id]] = id === 8 ? value : value.toString('utf8');
    }
  });
  for (const name of ['SeqID', 'LogID', 'service', 'method']) if (frame[name] === undefined) throw new Error('Incomplete frame');
  return frame;
}
