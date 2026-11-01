// Text shaping for the WeChat side: markdown in, phone-readable text out.

export function splitChunks(text, size) {
  const out = []
  let current = ''
  for (const para of text.split(/\n{2,}/)) {
    if ((current ? current.length + 2 : 0) + para.length <= size) {
      current = current ? `${current}\n\n${para}` : para
      continue
    }
    if (current) out.push(current)
    if (para.length <= size) {
      current = para
      continue
    }
    let rest = para
    while (rest.length > size) {
      out.push(rest.slice(0, size))
      rest = rest.slice(size)
    }
    current = rest
  }
  if (current) out.push(current)
  return out
}

/**
 * Markdown is for files; WeChat renders plain text. Strip the markers that turn into
 * noise on a phone, keep the code fences, and give every table row a readable line.
 */
export function toWechat(markdown) {
  const rows = markdown.split('\n').filter((line) => !/^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/.test(line))
  return rows
    .join('\n')
    .replace(/^#{1,6}\s+(.+)$/gm, '【$1】')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1（$2）')
    .replace(/^-\s+/gm, '· ')
    .replace(/^\s*\|(.+)\|\s*$/gm, (_m, inner) =>
      inner
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join('｜'),
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
