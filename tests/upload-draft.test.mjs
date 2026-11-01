import test from 'node:test'
import assert from 'node:assert/strict'
import { saveUploadDraft, verifyUploadDraft, clearUploadDraft, readUploadDraft } from '../extension/src/content/upload-draft.mjs'

test('draft continuation is bound to the same job, page, text and attachment names; sending is never replayed',t=>{
  const storage=new Map()
  globalThis.sessionStorage={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}
  globalThis.location={href:'https://chatgpt.com/c/original'}
  t.after(()=>{delete globalThis.sessionStorage;delete globalThis.location})
  const job={id:'one',text:'原问题',attachments:[{name:'photo.png'}]},state={count:1,names:['photo.png']}
  saveUploadDraft(job)
  assert.equal(verifyUploadDraft(job,'原问题',state).id,'one')
  assert.throws(()=>verifyUploadDraft({...job,id:'retry'},'原问题',state),/原任务/)
  assert.throws(()=>verifyUploadDraft(job,'已修改',state),/文字已变化/)
  assert.throws(()=>verifyUploadDraft(job,'原问题',{count:1,names:['another.png']}),/附件已变化/)
  location.href='https://chatgpt.com/c/elsewhere'
  assert.throws(()=>verifyUploadDraft(job,'原问题',state),/原任务/)
  location.href='https://chatgpt.com/c/original'
  saveUploadDraft(job,'sending')
  assert.throws(()=>verifyUploadDraft(job,'原问题',state),/原任务/)
  clearUploadDraft('other')
  assert.equal(readUploadDraft().id,'one')
  clearUploadDraft('one')
  assert.equal(readUploadDraft(),null)
})
