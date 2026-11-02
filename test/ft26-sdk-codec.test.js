// Dev-only oracle. The deployed runtime has no dependency on the SDK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame } from '../src/feishu-frame.js';

test('handwritten frame codec round-trips bytes produced by the actual pinned SDK encoder', async t => {
  let sdk;
  try { sdk = await import('@larksuiteoapi/node-sdk'); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') { t.skip('optional SDK omitted'); return; } throw error; }
  const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const ws = new sdk.WSClient({ appId: 'fixture', appSecret: 'fixture', logger: quiet });
  t.after(() => ws.close());
  let bytes;
  ws.wsConfig.getWSInstance = () => ({ readyState: 1, send(value, callback) { bytes = Buffer.from(value); callback?.(); }, removeAllListeners() {}, on() {}, close() {} });
  for (const input of [
    { SeqID: '0', LogID: '0', service: 7, method: 0, headers: [{ key: 'type', value: 'ping' }] },
    { SeqID: '18446744073709551615', LogID: '9223372036854775808', service: -1, method: 1,
      headers: [{ key: 'type', value: 'card' }, { key: 'message_id', value: '中文🙂' }],
      payloadEncoding: 'json', payloadType: 'application/json', payload: Buffer.from('中文\u0000🙂'), LogIDNew: 'new-id' },
    { SeqID: '123', LogID: '456', service: 0, method: 1, headers: [], payload: Buffer.alloc(0), payloadType: '', payloadEncoding: '', LogIDNew: '' },
  ]) {
    // SDK decoded IDs are protobuf Long objects. Its encoder rounds decimal
    // string IDs through Number, so use the actual decoded representation.
    const long = value => ({ low: Number(BigInt.asIntN(32, BigInt(value))), high: Number(BigInt.asIntN(32, BigInt(value) >> 32n)), unsigned: true });
    ws.sendMessage({ ...input, SeqID: long(input.SeqID), LogID: long(input.LogID) });
    assert.deepEqual(encodeFrame(input), bytes);
    const decoded = decodeFrame(bytes);
    assert.equal(decoded.SeqID, BigInt(input.SeqID)); assert.equal(decoded.LogID, BigInt(input.LogID));
    assert.deepEqual(encodeFrame(decoded), bytes);
  }
});
