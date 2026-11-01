export function answerKey(node) {
  for (let n=node, depth=0; n && depth<14; n=n.parentElement, depth++) {
    for (const name of ['data-chatgpt-selection-message-id','data-message-id','data-chatgpt-search-message-ids','data-turn-id','data-turn-key','data-item-key']) {
      const value=n.getAttribute(name)
      if (value) return name+':'+value
    }
    const id=n.getAttribute('id')
    if (id && /turn|message/.test(id)) return 'id:'+id
  }
  return ''
}

// Snapshot immediately BEFORE clicking send, after any slow uploads.
// A new DOM node is not evidence of a new reply: history is virtualized.
export function createAnswerTracker(nodes, { question, anchor='', root=document } = {}) {
  // Kept inside the factory: this file is also injected into a page as a bare
  // function body by the browser test, where module-level helpers do not exist.
  const convIdOf=url=>{try{return (new URL(url).pathname.match(/^\/c\/([^/]+)/)||[])[1]||''}catch{return ''}}
  const userSelector='[data-user-message-bubble],[data-message-author-role="user"],[data-markdown-text-style="user-message"]'
  const normalize=text=>String(text || '').replace(/\s+/g,' ').trim()
  const visible=n=>{const r=n.getBoundingClientRect();return n.isConnected && r.width>0 && r.height>0}
  const users=()=>[...root.querySelectorAll(userSelector)].filter(n=>!n.querySelector(userSelector))
  const oldKeys=new Set([...nodes,...users(),...root.querySelectorAll('[data-turn-key]')].map(answerKey).filter(Boolean))
  const oldUsers=new WeakSet(users())
  const previousUser=users().filter(visible).at(-1)
  const previousKey=previousUser ? answerKey(previousUser) : ''
  const oldAnswers=new WeakSet(nodes)
  const oldAnswerKeys=new Set(nodes.map(answerKey).filter(Boolean))
  const expected=normalize(question)
  // Context is prepended for a new conversation and the page re-renders its
  // markdown, so the bubble text cannot equal the prompt. The question itself
  // is always the tail of the prompt, so match on that instead.
  const anchorNorm=normalize(anchor)
  const textMatches=text=>{
    const t=normalize(text)
    if (!t) return false
    if (!anchorNorm) return t===expected
    return t.includes(anchorNorm) && t.length>=Math.max(anchorNorm.length, expected.length*0.6)
  }
  const existingConversation=!!convIdOf(root.defaultView?.location?.href || '')
  let questionKey='', selected=null, boundUrl='', boundConversation='', invalidReason='', findDiag=null

  function currentQuestion() {
    if (!expected) return null
    const url=root.defaultView?.location?.href || ''
    if (boundUrl) {
      const now=convIdOf(url)
      if (boundConversation) {
        // A different /c/<id> is a different conversation: this job can no
        // longer claim anything on screen.
        if (now!==boundConversation) { invalidReason=now ? 'conversation-changed' : 'left-conversation'; return null }
      } else if (now) {
        // A brand-new chat commits its id right after the first send: chatgpt.com/
        // or /?temp= becomes /c/<id> without replacing the page, so the binding
        // taken just before it still refers to this same turn.
        boundConversation=now
      }
      boundUrl=url
    }
    const list=users().filter(visible)
    if (questionKey) {
      const found=list.filter(n=>answerKey(n)===questionKey && textMatches(n.innerText))
      return found.length===1 && found[0]===list.at(-1) ? found[0] : null
    }
    const candidate=list.at(-1), key=candidate && answerKey(candidate)
    if (!candidate || !key || oldUsers.has(candidate) || oldKeys.has(key) || !textMatches(candidate.innerText)) return null
    // Turn IDs also exist on unloaded history placeholders.
    const turn=candidate.closest('[data-turn-key]')
    if (turn && oldKeys.has(answerKey(turn))) return null
    // An unseen historical question with the same text must not become this job.
    // Require order after the pre-send tail, including when that tail remounts.
    if (previousUser) {
      const boundary=list.find(n=>answerKey(n)===previousKey) || (previousUser.isConnected ? previousUser : null)
      if (!boundary || !(boundary.compareDocumentPosition(candidate) & 4)) return null
    }
    questionKey=key
    boundUrl=url
    boundConversation=convIdOf(url)
    return candidate
  }

  // The answer node and its question normally share a [data-turn-key] wrapper, but
  // the page sometimes nests one inside the other (or keeps the key on an outer
  // container), so accept either side containing the other.
  const sameTurn=(node, turn)=>{
    const at=node.closest('[data-turn-key]')
    return !at || at===turn || turn.contains(at) || at.contains(turn)
  }

  return {
    canSend() { return !existingConversation || !!previousUser },
    // Non-empty once the page moved to another conversation; the caller should
    // stop waiting instead of burning the whole timeout.
    invalid() { return invalidReason },
    find(candidates) {
      findDiag={gate:'',nodes:candidates.length,visible:0,old:0,notAfter:0,otherTurn:0,empty:0,matches:0}
      if (existingConversation && !previousUser) { findDiag.gate='no-previous-user'; return null }
      const user=currentQuestion()
      selected=null
      if (!user) { findDiag.gate=invalidReason ? `binding-invalid:${invalidReason}` : 'no-question'; return null }
      const turn=user.closest('[data-turn-key]')
      const matches=candidates.filter(n=>{
        if (!visible(n) || n.getBoundingClientRect().width<=100) { findDiag.visible++; return false }
        if (oldAnswers.has(n) || oldAnswerKeys.has(answerKey(n))) { findDiag.old++; return false }
        if (!(user.compareDocumentPosition(n) & 4)) { findDiag.notAfter++; return false }
        if (turn && !sameTurn(n, turn)) { findDiag.otherTurn++; return false }
        const text=(n.innerText || '').trim()
        if (!text || (/^思考了\s*\d/.test(text) && text.length<12)) { findDiag.empty++; return false }
        return true
      })
      findDiag.matches=matches.length
      // The final reply may replace an intermediate search message in this turn.
      selected=matches.at(-1) || null
      return selected
    },
    isComplete(node) {
      if (!node || node!==selected || !currentQuestion()) return false
      const state=node.closest('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state')
      return !state || state==='complete'
    },
    binding() {
      return {revision:'question-bound-v1',questionKey,answerKey:selected ? answerKey(selected) : ''}
    },
    debug() {
      const list=users().filter(visible)
      const last=list.at(-1)
      const text=last ? normalize(last.innerText) : ''
      const url=root.defaultView?.location?.href || ''
      return {
        mode:anchorNorm ? 'anchor' : 'exact',
        expectedLen:expected.length,
        anchorLen:anchorNorm.length,
        users:list.length,
        lastLen:text.length,
        lastKey:last ? answerKey(last) : '',
        lastIsOld:last ? oldUsers.has(last) : null,
        lastKeyIsOld:last ? oldKeys.has(answerKey(last)) : null,
        textMatches:last ? textMatches(last.innerText) : false,
        hasPreviousUser:!!previousUser,
        existingConversation,
        questionKey,
        url,
        boundUrl,
        conversationId:convIdOf(url),
        boundConversation,
        invalidReason,
        find:findDiag,
      }
    },
  }
}
