// Keep early preferences as well as recent turns within a bounded provider request.
export function conversationContext(messages, budget = 48000) {
  const clean = messages.filter(
    (m) =>
      ['user', 'assistant'].includes(m.role) && typeof m.content === 'string',
  );
  if (clean.reduce((n, m) => n + m.content.length, 0) <= budget) return clean;
  const first = clean
    .slice(0, 4)
    .map((m) => ({ ...m, content: m.content.slice(0, 1500) }));
  let remaining = budget - first.reduce((n, m) => n + m.content.length, 0);
  const recent = [];
  for (let i = clean.length - 1; i >= 4 && remaining > 0; i--) {
    const content = clean[i].content.slice(-remaining);
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
