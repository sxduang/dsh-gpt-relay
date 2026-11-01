import test from 'node:test'
import assert from 'node:assert/strict'
import {checkTabInput} from '../extension/src/background/tab-state.mjs'
import {setText} from '../extension/src/content/typing.mjs'

test('an attached debugger blocks input without toggling or detaching it',async t=>{
  t.after(()=>{delete globalThis.chrome})
  globalThis.chrome={debugger:{getTargets:async()=>[{tabId:9,attached:true}]}}
  const result=await checkTabInput(9)
  assert.equal(result.error,'debugger-busy')
  assert.equal((await checkTabInput(10)).ok,true)
})

test('typing stops if focus cannot be placed in the page composer',t=>{
  t.after(()=>{delete globalThis.document})
  globalThis.document={activeElement:{},execCommand(){throw new Error('must not type')}}
  assert.equal(setText({focus(){},contains:()=>false},'问题'),false)
})
