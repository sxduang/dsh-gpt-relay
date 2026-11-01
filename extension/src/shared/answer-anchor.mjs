// Only recover the same message/turn, never a text match elsewhere in history.
export function describeAnswerAnchor(node) {
  const path = []
  for (let owner=node, depth=0; owner && depth<14; owner=owner.parentElement, depth++) {
    for (const attribute of ['data-chatgpt-selection-message-id','data-message-id','data-turn-id','data-turn-key','data-item-key','id']) {
      const value=owner.getAttribute(attribute)
      if (!value || (attribute==='id' && !/turn|message/.test(value))) continue
      const text=(node.textContent || '').replace(/\s+/g,' ').trim()
      return {attribute,value,path,tag:node.tagName,role:node.getAttribute('data-message-author-role'),markdownStyle:node.getAttribute('data-markdown-text-style'),prefix:text.slice(0,192),suffix:text.slice(-192)}
    }
    if (owner.parentElement) path.unshift([...owner.parentElement.children].indexOf(owner))
  }
  return null
}

// Self-contained: also executed by CDP in the page's main world.
export function resolveAnswerAnchor(identity, root=document) {
  if (!identity || !['data-chatgpt-selection-message-id','data-message-id','data-turn-id','data-turn-key','data-item-key','id'].includes(identity.attribute)) return null
  const matches=node=>{
    if (!node?.isConnected || node.tagName!==identity.tag || node.getAttribute('data-message-author-role')!==identity.role) return false
    if (node.getAttribute('data-markdown-text-style')!==(identity.markdownStyle || null)) return false
    const text=(node.textContent || '').replace(/\s+/g,' ').trim()
    const r=node.getBoundingClientRect()
    return r.width>100 && r.height>0 && text.slice(0,192)===identity.prefix && text.slice(-192)===identity.suffix
  }
  const found=new Set()
  for (const owner of root.querySelectorAll('['+identity.attribute+']')) {
    if (owner.getAttribute(identity.attribute)!==identity.value) continue
    let node=owner
    for (const index of identity.path || []) node=node?.children[index]
    if (matches(node)) found.add(node)
    else for (const candidate of [owner,...owner.querySelectorAll('*')]) if(matches(candidate)) found.add(candidate)
  }
  return found.size===1 ? [...found][0] : null
}
