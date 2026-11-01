import test from 'node:test'
import assert from 'node:assert/strict'
import { runProbe } from '../extension/src/content/diagnostics.mjs'
import { answerKey } from '../extension/src/content/answer-target.mjs'

function answer(id) {
  const attrs=new Map([['data-markdown-text-style','assistant-message']])
  const node={isConnected:true,tagName:'DIV',textContent:'原回答',innerText:'原回答',
    getAttribute:key=>attrs.get(key) ?? null,setAttribute:(key,value)=>attrs.set(key,value),removeAttribute:key=>attrs.delete(key),
    getBoundingClientRect:()=>({width:600,height:300})}
  node.parentElement={children:[node],parentElement:null,getAttribute:key=>key==='data-chatgpt-selection-message-id'?id:null}
  return node
}

test('answer key recognizes the current ChatGPT selection-message identity across remounts',()=>{
  const old=answer('old'),fresh=answer('new')
  old.textContent=old.innerText='旧回答'
  assert.equal(answerKey(fresh),'data-chatgpt-selection-message-id:new')
  fresh.isConnected=false
  const replacement=answer('new')
  assert.equal(answerKey(replacement),answerKey(fresh))
})

test('diagnostic capture requires exact conversation and unique message, and restores its marker',async t=>{
  t.after(()=>{delete globalThis.document;delete globalThis.location;delete globalThis.chrome})
  let nodes=[answer('reply')],requests=[]
  globalThis.document={title:'Test',querySelectorAll:()=>nodes}
  globalThis.location={href:'https://chatgpt.com/c/test'}
  globalThis.chrome={runtime:{sendMessage:async request=>{requests.push(request);return {ok:true,dataUrl:'data:image/png;base64,test',info:{revision:'anchor-recovery-v2'}}}}}
  const sels={assistant:'[data-markdown-text-style="assistant-message"]'}
  const capture={url:location.href,messageId:'reply'}
  const result=await runProbe({capture},sels)
  assert.equal(result.capture.info.revision,'anchor-recovery-v2')
  assert.equal(requests.length,1)
  assert.equal(requests[0].rect.identity.value,'reply')
  assert.equal(nodes[0].getAttribute('data-gpt-relay-answer'),null)
  assert.equal((await runProbe({capture:{...capture,url:'https://chatgpt.com/c/other'}},sels)).capture.error,'capture-target-mismatch')
  nodes.push(answer('reply'))
  assert.equal((await runProbe({capture},sels)).capture.error,'capture-target-not-unique')
  assert.equal(requests.length,1)
})
