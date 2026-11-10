// In-memory implementation of the public transport contract. No Feishu connection.
export class FakeTransport {
  constructor() { this.calls = []; this.messages = new Map(); this.sequence = 0; }
  async send(chatId, content, uuid) {
    const id = `om_test${++this.sequence}`;
    this.calls.push({ op: 'send', id, chatId, content: structuredClone(content), uuid });
    this.messages.set(id, { message_id: id, chat_id: chatId, body: { content: JSON.stringify(content) } });
    return id;
  }
  async reply(topicId, content, type = 'text', uuid) {
    const id = `om_test${++this.sequence}`;
    this.calls.push({ op: 'reply', id, topicId, content: structuredClone(content), type, uuid });
    this.messages.set(id, { message_id: id, root_id: topicId, body: { content: JSON.stringify(content) } });
    return id;
  }
  async patch(id, card) { this.calls.push({ op: 'patch', id, card: structuredClone(card) }); }
  async getMessage(id) {
    this.calls.push({ op: 'getMessage', id });
    if (!this.messages.has(id)) throw Object.assign(new Error('Missing fake message'), { code: '230011' });
    return structuredClone(this.messages.get(id));
  }
}
