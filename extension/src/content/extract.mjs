export function tableToMd(table) {
  const rows = [...table.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('th,td')].map((c) => (c.innerText || '').trim().replace(/\s*\n\s*/g, ' ')),
  )
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r) => [...r, ...Array(width - r.length).fill('')]
  const header = pad(rows[0])
  const sep = header.map(() => '---')
  const body = rows.slice(1).map(pad)
  return [header, sep, ...body].map((r) => `| ${r.join(' | ')} |`).join('\n')
}

export function extractMd(node) {
  const clone = node.cloneNode(true)
  clone
    .querySelectorAll('button, svg, style, script, img, [data-testid="copy-turn-action-button"], .sr-only')
    .forEach((n) => n.remove())

  clone.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code') || pre
    const lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || ''
    const body = (code.innerText || '').replace(/\n+$/, '')
    pre.replaceWith(document.createTextNode(`\n\`\`\`${lang}\n${body}\n\`\`\`\n`))
  })

  clone.querySelectorAll('table').forEach((t) => t.replaceWith(document.createTextNode(`\n${tableToMd(t)}\n`)))

  clone.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    const level = Number(h.tagName[1])
    h.replaceWith(document.createTextNode(`\n${'#'.repeat(level)} ${(h.innerText || '').trim()}\n`))
  })

  clone.querySelectorAll('.katex').forEach((k) => {
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')
    if (tex) k.replaceWith(document.createTextNode(`$${tex.textContent}$`))
  })

  clone.querySelectorAll('strong,b').forEach((n) => n.replaceWith(document.createTextNode(`**${n.innerText}**`)))
  clone.querySelectorAll('em,i').forEach((n) => n.replaceWith(document.createTextNode(`*${n.innerText}*`)))
  clone.querySelectorAll('li').forEach((li) => li.prepend(document.createTextNode('- ')))
  clone.querySelectorAll('br').forEach((b) => b.replaceWith(document.createTextNode('\n')))

  // Keep the address of every link: on a phone the citations are the part most
  // worth following up on, and innerText drops them.
  clone.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    const label = (a.innerText || '').trim()
    if (!href || href.startsWith('#')) {
      a.replaceWith(document.createTextNode(label))
      return
    }
    let absolute = href
    try {
      absolute = new URL(href, location.href).toString()
    } catch {
      /* keep as given */
    }
    if (!label || label === absolute) a.replaceWith(document.createTextNode(absolute))
    else a.replaceWith(document.createTextNode(`${label}（${absolute}）`))
  })

  return (clone.innerText || clone.textContent || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function richness(node) {
  const images = [...node.querySelectorAll('img')].filter(
    (img) => (img.naturalWidth || 0) >= 120 && !/favicon|s2\/favicons|avatar/i.test(img.currentSrc || img.src || ''),
  ).length
  return {
    images,
    tables: node.querySelectorAll('table').length,
    boxes: node.querySelectorAll('[data-d-component="box"]').length,
    math: node.querySelectorAll('.katex').length,
    canvas: node.querySelectorAll('canvas').length,
  }
}
