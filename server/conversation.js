// Keep early preferences as well as recent turns within a bounded provider request.
export function conversationContext(messages, budget = 4500) {
  const clean = messages.filter(
    (m) =>
      ['user', 'assistant'].includes(m.role) && typeof m.content === 'string',
  );
  if (clean.reduce((n, m) => n + m.content.length, 0) <= budget) return clean;
  const trim = (content, limit) => {
    if (content.length <= limit) return content;
    const marker = '\n[message shortened]\n';
    if (limit <= marker.length) return content.slice(0, limit);
    const available = limit - marker.length;
    const first = Math.ceil(available * 0.7);
    return `${content.slice(0, first)}${marker}${content.slice(-(available - first))}`;
  };
  const first = clean
    .slice(0, 2)
    .map((m) => ({ ...m, content: trim(m.content, 600) }));
  let remaining = budget - first.reduce((n, m) => n + m.content.length, 0);
  const recent = [];
  for (let i = clean.length - 1; i >= 2 && remaining > 0; i--) {
    const content = trim(clean[i].content, Math.min(1200, remaining));
    recent.unshift({ ...clean[i], content });
    remaining -= content.length;
  }
  return [...first, ...recent];
}

export function plainReply(value) {
  let text = String(value || '').replace(/```[^\n]*\n?([\s\S]*?)```/g, '$1');
  // Convert tables to labelled sentences, rather than leaking Markdown separators.
  text = text.replace(
    /(^[^\n]*\|[^\n]*\n)[ \t]*\|?[ \t]*:?-{2,}[^\n]*\n((?:[^\n]*\|[^\n]*(?:\n|$))+)/gm,
    (_all, header, rows) => {
      const cells = (line) =>
        line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((s) => s.trim());
      const labels = cells(header);
      return (
        rows
          .trim()
          .split('\n')
          .map((row) =>
            cells(row)
              .map((v, i) => `${labels[i] || 'Details'}: ${v}`)
              .join('. '),
          )
          .join('\n\n') + '\n'
      );
    },
  );
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/^\s*[-_]{3,}\s*$/gm, '')
    .replace(/\*|`/g, '')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
