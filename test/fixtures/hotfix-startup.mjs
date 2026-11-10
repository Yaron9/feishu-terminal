// Exercise the real no-argument CLI lifecycle with local transport boundaries.
// No live credentials, backend processes or Feishu connection are used.
import { HcBackend } from '../../src/backends/hc.js';
import { FeishuWSClient } from '../../src/feishu-ws.js';
HcBackend.prototype.list = async () => [];
HcBackend.prototype.dispose = async () => {};
FeishuWSClient.prototype.start = async function () {
  setTimeout(() => process.emit('SIGTERM'), 20);
};
FeishuWSClient.prototype.close = function () {};
