import test from 'node:test'
import assert from 'node:assert/strict'
import { planCapturePages, composeCapturePages } from '../extension/src/background/capture-pages.mjs'

test('page plans cover the exact tail at fractional DPR and never exceed image area/height bounds',()=>{
  for(const dpr of [1,1.25,1.5,2]) for(const height of [1,19904,20000,20390.36328125,50000,103333.7]) {
    const plan=planCapturePages(height,768,38,dpr)
    let end=0
    for(const page of plan.pages) {
      assert.equal(page.startPx,end)
      assert.ok(page.endPx>page.startPx)
      assert.ok(page.heightPx<=25000)
      assert.ok(page.heightPx*plan.widthPx<=32_000_000)
      assert.equal(page.heightPx,page.endPx-page.startPx+2*plan.paddingPx)
      end=page.endPx
    }
    assert.equal(end,Math.ceil(height*dpr))
  }
})

test('compositor refuses incomplete coverage instead of declaring a prefix complete',async()=>{
  await assert.rejects(composeCapturePages([],{contentPx:100}),/answer-incomplete/)
  await assert.rejects(composeCapturePages([{startPx:5,endPx:10}],{contentPx:10}),/page-gap/)
})
