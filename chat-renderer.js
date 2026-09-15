/** Track changed messages so unrelated chat mutations never rebuild existing portraits. */
export function createChatRenderer(renderer) {
  const rendered = new Set();
  const dirty = new Set();

  function markMutations(records) {
    let relevant = false;
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      // Image load/error handling changes only the portrait, not dialogue content.
      if (element?.closest('.sp-avatar')) continue;
      const root = element?.closest('.mes_text');
      if (root) { dirty.add(root); relevant = true; }
      if (record.type === 'childList') {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node.nodeType === 1 && (node.matches('.mes,.mes_text') || node.querySelector('.mes,.mes_text'))) {
            relevant = true;
          }
        }
      }
    }
    return relevant;
  }

  function render(chat, { depth = 0, totalMessages = null, enabled = true, reset = false } = {}) {
    if (!chat) { rendered.clear(); dirty.clear(); return; }
    const roots = Array.from(chat.querySelectorAll('.mes_text'));
    // Count chat messages (including user messages and messages without dialogue), not speakers.
    const messages = [...new Set(roots.map(root => root.closest('.mes') ?? root))];
    const recent = new Set(depth > 0 ? messages.slice(-depth) : messages);
    const selected = new Set(enabled ? roots.filter(root => {
      if (depth === 0) return true;
      const message = root.closest('.mes');
      const id = message?.getAttribute('mesid');
      // ST can load only part of a chat. Old loaded messages must not count as recent.
      if (Number.isInteger(totalMessages) && totalMessages > 0 && /^\d+$/.test(id ?? '')) {
        return Number(id) >= Math.max(0, totalMessages - depth) && Number(id) < totalMessages;
      }
      return recent.has(message ?? root);
    }) : []);
    const expired = [...rendered].filter(root => !selected.has(root) && chat.contains(root));
    const changed = [...selected].filter(root => reset || !rendered.has(root) || dirty.has(root));
    if (expired.length || changed.length) {
      const top = chat.getBoundingClientRect().top;
      const bottom = chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 4;
      const anchor = bottom ? null : messages.find(message => message.getBoundingClientRect().bottom > top);
      const anchorTop = anchor?.getBoundingClientRect().top;
      for (const root of expired) renderer.restore(root);
      for (const root of changed) renderer.render(root, { reset: reset && rendered.has(root) });
      // Compensate only for this render's height changes; do not replay an old scroll position.
      if (bottom) chat.scrollTop = Math.max(0, chat.scrollHeight - chat.clientHeight);
      else if (anchor?.isConnected) chat.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }
    rendered.clear();
    for (const root of selected) rendered.add(root);
    dirty.clear();
  }

  return { render, markMutations };
}
