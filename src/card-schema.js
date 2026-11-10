// Message cards cannot change JSON schema after delivery. Keep rendering
// independent of the current terminal mode, which can change across restarts.
export const cardVersion = card => card.schema === '2.0' ? '2.0' : '1.0';
export const kindVersion = kind => ({ status: '1.0', picker: '1.0', turn: '2.0', menu: '2.0', root: '2.0', tree: '2.0' })[kind];

export function renderSchema(card, version) {
  if (cardVersion(card) === version && version === '1.0') return card;
  const convert = elements => elements.flatMap(element => {
    const e = structuredClone(element);
    if (version === '2.0') {
      if (e.tag === 'action') return convert(e.actions);
      if (e.tag === 'div') return [{ tag: 'markdown', content: e.text.content }];
      if (e.tag === 'note') return [{ tag: 'markdown', content: e.elements.map(t => t.content).join('\n') }];
      if (['button', 'interactive_container'].includes(e.tag) && e.value) {
        e.behaviors = [{ type: 'callback', value: e.value }]; delete e.value;
      }
    } else {
      if (e.tag === 'column_set') return convert(e.columns.flatMap(c => c.elements));
      if (e.tag === 'collapsible_panel') return convert(e.elements);
      if (e.tag === 'interactive_container') return [{ tag: 'action', actions: [{ tag: 'button',
        text: { tag: 'plain_text', content: e.elements.map(t => t.content).join('\n') },
        value: e.behaviors.find(b => b.type === 'callback')?.value }] }];
      if (e.tag === 'button') {
        e.value = e.behaviors?.find(b => b.type === 'callback')?.value ?? e.value;
        delete e.behaviors; delete e.width;
        return [{ tag: 'action', actions: [e] }];
      }
    }
    if (e.elements) e.elements = convert(e.elements);
    if (e.columns) e.columns = e.columns.map(c => ({ ...c, elements: convert(c.elements) }));
    return [e];
  });
  const elements = convert(card.body?.elements ?? card.elements);
  return version === '2.0' ? { schema: '2.0', config: { update_multi: true }, header: card.header, body: { elements } } :
    { config: { wide_screen_mode: true, update_multi: true }, header: card.header, elements };
}

export function retirementCard() {
  return { schema: '2.0', config: { update_multi: true },
    header: { template: 'grey', title: { tag: 'plain_text', content: '已结束 · 已移至新卡片' } },
    body: { elements: [{ tag: 'markdown', content: "<font color='grey'>已移至下方新卡片</font>" }] } };
}

export async function patchStoredCard({ store, feishu }, id, card, kind) {
  const known = store.data.cardSchemas?.[id];
  const inferred = kindVersion(kind);
  let version = known?.schemaVersion ?? inferred ?? '1.0';
  const remember = () => store.transaction(data => {
    if (data.cardSchemas) delete data.cardSchemas[id];
    (data.cardSchemas ??= {})[id] = { ...known, schemaVersion: version, kind: known?.kind ?? kind ?? null, updatedAt: store.now() };
  });
  // Unknown legacy IDs get one v2 attempt on the specific schema error.
  // Persist before that attempt so a reboot cannot repeat the v1 probe.
  try { await feishu.patch(id, renderSchema(card, version)); }
  catch (error) {
    if (known || inferred || !/200830/.test(`${error.code} ${error.detail ?? ''} ${error.message}`)) throw error;
    version = '2.0'; await remember();
    await feishu.patch(id, renderSchema(card, version));
  }
  await remember();
  return version;
}
