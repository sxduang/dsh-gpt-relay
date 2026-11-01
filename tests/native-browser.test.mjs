import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { captureNative as captureNativeImpl } from '../extension/src/background/native-capture.mjs'
import { composeCapturePages } from '../extension/src/background/capture-pages.mjs'
let composeInBrowser
const captureNative=(tabId,rect)=>captureNativeImpl(tabId,rect,{compose:composeInBrowser})
import { answerKey, createAnswerTracker } from '../extension/src/content/answer-target.mjs'
import { waitAnswer } from '../extension/src/content/wait-answer.mjs'
import { describeAnswerAnchor } from '../extension/src/shared/answer-anchor.mjs'
import { runAsk } from '../extension/src/content/ask.mjs'
import { attachmentScope, attachmentState, uploadAttachments, waitAttachments } from '../extension/src/content/attachments.mjs'
import { readUploadDraft, saveUploadDraft, clearUploadDraft, verifyUploadDraft } from '../extension/src/content/upload-draft.mjs'

function fakeNode(id,text,visible=true) {
  return {isConnected:true,innerText:text,textContent:text,parentElement:null,
    getAttribute:key=>key==='data-message-id'?id:null,
    getBoundingClientRect:()=>({width:visible?600:0,height:visible?100:0})}
}
test('unbound answer tracker never adopts a reply without confirmation of the current question',()=>{
  const tracker=createAnswerTracker([fakeNode('old','历史回答')],{root:{querySelectorAll:()=>[]}})
  const answer=fakeNode('new','这次回答')
  assert.equal(tracker.find([fakeNode('old','历史回答'),answer,fakeNode('hidden','隐藏副本',false)]),null)
  answer.isConnected=false
  assert.equal(tracker.find([fakeNode('unrelated','其他回答')]),null)
  const remounted=fakeNode('new','这次回答完成')
  assert.equal(tracker.find([remounted]),null)
})

test('unloaded existing conversation cannot submit or bind a late historical question',()=>{
  const root={querySelectorAll:()=>[],defaultView:{location:{pathname:'/c/existing',href:'https://chatgpt.com/c/existing'}}}
  const tracker=createAnswerTracker([],{question:'重复问题',root})
  assert.equal(tracker.canSend(),false)
  assert.equal(tracker.find([fakeNode('late-old','旧回答')]),null)
})

test('real Chrome captures one continuous answer without scrolling through history or changing viewport', {timeout:60000}, async t=>{
  const executable=process.env.RELAY_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  await fs.access(executable)
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'relay-native-test-'))
  const dpr=Number(process.env.RELAY_TEST_DPR || 1)
  const child=spawn(executable,['--headless=new',`--force-device-scale-factor=${dpr}`,'--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-extensions','about:blank'],{stdio:'ignore',windowsHide:true})
  let socket
  t.after(async()=>{
    socket?.close(); child.kill()
    await Promise.race([once(child,'exit').catch(()=>{}),new Promise(r=>setTimeout(r,1500))])
    if (path.dirname(profile) !== os.tmpdir() || !path.basename(profile).startsWith('relay-native-test-')) throw new Error('Unsafe test cleanup path')
    await fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{})
    delete globalThis.chrome
  })
  let port
  for(let i=0;i<150;i++) {
    try { port=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break } catch { await new Promise(r=>setTimeout(r,100)) }
  }
  assert.ok(port,'Chrome debugging endpoint did not start')
  const tabs=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject})
  let serial=0
  const pending=new Map()
  socket.onmessage=event=>{const msg=JSON.parse(event.data);const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result)}}
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))})
  const evaluate=async expression=>{const response=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(response.exceptionDetails)throw new Error(JSON.stringify(response.exceptionDetails));return response.result.value}
  composeInBrowser=(pages,meta)=>evaluate(`(${composeCapturePages.toString()})(${JSON.stringify(pages)},${JSON.stringify(meta)})`)
  await t.test('CDP script suspension blocks page callbacks but permits read-only capture verification',async()=>{
    await evaluate('window.captureTimer=0;setTimeout(()=>window.captureTimer++,100)')
    await send('Emulation.setScriptExecutionDisabled',{value:true})
    try {
      await new Promise(resolve=>setTimeout(resolve,250))
      assert.equal(await evaluate('window.captureTimer'),0)
    } finally { await send('Emulation.setScriptExecutionDisabled',{value:false}) }
    await evaluate('window.afterFreeze=0;setTimeout(()=>window.afterFreeze++,0)')
    await new Promise(resolve=>setTimeout(resolve,100))
    assert.equal(await evaluate('window.afterFreeze'),1)
  })
  const bands=Array.from({length:40},(_,i)=>`<div class="band" style="height:150px;background:rgb(${30+i*4},${80+i*2},130)">Section ${i+1} — original rendered content</div>`).join('')
  const html=`<style>body{margin:0;background:white}.scroll{height:600px;overflow:auto;transform:translateZ(0);contain:paint}#history{height:120000px}#answer{width:600px;margin:0 auto;font:20px sans-serif}.band{box-sizing:border-box;border-top:1px solid white}#later{height:100px;background:red}header{position:fixed;top:0;background:orange;width:100%;height:60px}</style><header>OVERLAY MUST NOT BE CAPTURED</header><div class="scroll"><div id="history">OLD HISTORY</div><section id="answer" data-gpt-relay-answer="job-test">${bands}</section><div id="later">OTHER ANSWER</div><div data-gpt-relay-answer="hidden" style="display:none">HIDDEN</div></div>`
  await send('Page.navigate',{url:'data:text/html,'+encodeURIComponent(html)})
  for(let i=0;i<100;i++){if(await evaluate('!!document.getElementById("answer")'))break;await new Promise(r=>setTimeout(r,30))}
  await evaluate('document.querySelector(".scroll").scrollTop=999999')
  await evaluate('document.getElementById("answer").setAttribute("style","margin-top:0px;overflow-x:visible")')
  const before=await evaluate('({width:innerWidth,height:innerHeight,scroll:document.querySelector(".scroll").scrollTop,html:document.documentElement.outerHTML})')
  let screenshots=0
  const commands=[]
  globalThis.chrome={debugger:{async attach(){},async detach(){},async sendCommand(target,method,params){commands.push(method);if(method==='Page.captureScreenshot')screenshots++;return send(method,params)}}}
  const result=await captureNative(1,{selector:'[data-gpt-relay-answer="job-test"]'})
  assert.equal(result.ok,true,JSON.stringify(result))
  assert.equal(result.info.slices,1)
  assert.equal(screenshots,1)
  assert.equal(result.info.height,6060)
  const after=await evaluate('({width:innerWidth,height:innerHeight,scroll:document.querySelector(".scroll").scrollTop,html:document.documentElement.outerHTML})')
  assert.deepEqual(after,before)
  assert.ok(!commands.some(command=>command.startsWith('Emulation.') && command!=='Emulation.setScriptExecutionDisabled'))
  const pixels=await evaluate(`(async()=>{const img=new Image();img.src=${JSON.stringify(result.dataUrl)};await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return {width:img.width,height:img.height,rows:Array.from({length:40},(_,i)=>[...ctx.getImageData(Math.round(60*${dpr}),Math.round((30+i*150+70)*${dpr}),1,1).data])}})()`)
  assert.equal(pixels.height,Math.round(6060*dpr))
  for(let i=0;i<40;i++) assert.deepEqual(pixels.rows[i],[30+i*4,80+i*2,130,255],`Missing or repeated band ${i}`)
  // Failure after layout changes must still restore exact styles and scrolling.
  globalThis.chrome.debugger.sendCommand=async(target,method,params)=>{if(method==='Page.captureScreenshot')throw new Error('injected screenshot failure');return send(method,params)}
  await assert.rejects(captureNative(1,{selector:'[data-gpt-relay-answer="job-test"]'}),/injected/)
  assert.deepEqual(await evaluate('({width:innerWidth,height:innerHeight,scroll:document.querySelector(".scroll").scrollTop,html:document.documentElement.outerHTML})'),before)
  let retryShots=0
  globalThis.chrome.debugger.sendCommand=async(target,method,params)=>{
    const response=await send(method,params)
    if(method==='Page.captureScreenshot' && ++retryShots===1) await evaluate('document.querySelector(".band").style.height="180px"')
    return response
  }
  const recovered=await captureNative(1,{selector:'[data-gpt-relay-answer="job-test"]'})
  assert.equal(recovered.ok,true)
  assert.equal(recovered.info.attempts,2)
  assert.equal(recovered.info.height,6090)
  assert.equal(retryShots,2)
  assert.equal(await evaluate('document.body.getAttribute("style")'),null)
  let unstableShots=0
  globalThis.chrome.debugger.sendCommand=async(target,method,params)=>{
    const response=await send(method,params)
    if(method==='Page.captureScreenshot') {unstableShots++;await evaluate('(()=>{const band=document.querySelector(".band");band.style.height=(parseFloat(band.style.height)+2)+"px"})()')}
    return response
  }
  const unstable=await captureNative(1,{selector:'[data-gpt-relay-answer="job-test"]'})
  assert.equal(unstable.ok,false)
  assert.equal(unstable.error,'answer-layout-unstable-after-retries')
  assert.equal(unstableShots,4)
  assert.equal(await evaluate('document.body.getAttribute("style")'),null)
  if(process.env.RELAY_CAPTURE_PREVIEW) await fs.writeFile(process.env.RELAY_CAPTURE_PREVIEW,Buffer.from(result.dataUrl.split(',')[1],'base64'))
  console.log(JSON.stringify({nativeCaptureMs:result.info.durationMs,width:result.info.width,height:result.info.height,screenshots,verifiedBands:40}))

  // Real DOM lifecycle regressions: replace the target as a virtual list would,
  // including losing the temporary marker and changing its child index.
  const fixture=`<article style="display:flex;flex-direction:column;width:600px"><div data-message-id="reply-17"><section id="answer" data-message-author-role="assistant" data-gpt-relay-answer="job-test" style="margin:24px 0">${bands}</section></div></article><section id="other" data-message-id="reply-other" data-message-author-role="assistant">OTHER ANSWER</section>`
  const reset=async()=>{
    await evaluate(`document.body.innerHTML=${JSON.stringify(fixture)}`)
    return evaluate(`(${describeAnswerAnchor.toString()})(document.getElementById('answer'))`)
  }
  const remount=()=>evaluate(`(()=>{
    const parent=document.querySelector('[data-message-id="reply-17"]');
    parent.innerHTML=${JSON.stringify('<span>new sibling</span><section id="answer" data-message-author-role="assistant" style="margin:24px 0">'+bands+'</section>')};
  })()`)
  const rect=identity=>({selector:'[data-gpt-relay-answer="job-test"]',identity})
  const normalSend=(target,method,params)=>send(method,params)

  await t.test('repeated app remounts during raster fail without suspension and succeed with it',async()=>{
    let protect=false,shots=0
    chrome.debugger.sendCommand=async(target,method,params)=>{
      if(method==='Emulation.setScriptExecutionDisabled' && !protect) return {}
      if(method==='Page.captureScreenshot') {
        shots++
        await evaluate(`setTimeout(()=>{document.querySelector('[data-message-id="reply-17"]').innerHTML=${JSON.stringify('<section id="answer" data-message-author-role="assistant" style="margin:24px 0">'+bands+'</section>')};},0)`)
        await new Promise(resolve=>setTimeout(resolve,30))
      }
      return send(method,params)
    }
    const first=await reset()
    const failing=await captureNative(1,rect(first))
    assert.equal(failing.ok,false)
    assert.equal(shots,4)
    assert.ok(failing.detail.attempts.every(a=>a.phase==='after-shot' && a.cause==='answer-node-detached'))
    protect=true;shots=0
    const second=await reset()
    const fixed=await captureNative(1,rect(second))
    assert.equal(fixed.ok,true,JSON.stringify(fixed))
    assert.equal(fixed.info.revision,'capture-pages-v4')
    assert.equal(shots,1)
    assert.equal(fixed.info.height,6060)
    await evaluate('window.captureResumed=false;setTimeout(()=>window.captureResumed=true,0)')
    await new Promise(resolve=>setTimeout(resolve,80))
    assert.equal(await evaluate('window.captureResumed'),true)
    assert.equal(await evaluate('document.body.getAttribute("style")'),null)
  })

  await t.test('raster failure restores layout and resumes page scripts',async()=>{
    const identity=await reset()
    chrome.debugger.sendCommand=async(target,method,params)=>{
      if(method==='Page.captureScreenshot') throw new Error('raster failed while suspended')
      return send(method,params)
    }
    await assert.rejects(captureNative(1,rect(identity)),/raster failed/)
    await evaluate('window.failureResumed=false;setTimeout(()=>window.failureResumed=true,0)')
    await new Promise(resolve=>setTimeout(resolve,80))
    assert.equal(await evaluate('window.failureResumed'),true)
    assert.equal(await evaluate('document.body.getAttribute("style")'),null)
  })

  await t.test('task binding rejects late history, follows the current final reply, and survives remounts',async()=>{
    const checks=await evaluate(`(()=>{
      ${answerKey.toString()}
      ${createAnswerTracker.toString()}
      const turn=(id,text,reply,state='complete')=>'<div data-turn-key="'+id+'"><div data-talvt-turn-state="'+state+'"><div data-user-message-bubble>'+text+'</div><div data-chatgpt-selection-message-id="a-'+id+'"><div data-markdown-text-style="assistant-message" style="width:600px">'+reply+'</div></div></div></div>';
      const nodes=()=>[...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')];
      document.body.innerHTML=turn('old','重复问题','旧回答')+'<div data-turn-key="unloaded"></div>';
      const tracker=createAnswerTracker(nodes(),{question:'重复问题'});
      document.querySelector('[data-turn-key=old]').outerHTML=turn('old','重复问题','旧回答重新挂载');
      document.querySelector('[data-turn-key=unloaded]').outerHTML=turn('unloaded','重复问题','延迟加载的旧回答');
      const historyRejected=tracker.find(nodes())===null;
      document.body.insertAdjacentHTML('beforeend',turn('current','重复问题','我来搜索一下','streaming'));
      const first=tracker.find(nodes());
      const intermediatePending=first?.innerText==='我来搜索一下' && !tracker.isComplete(first);
      document.querySelector('[data-turn-key=current] [data-talvt-turn-state]').insertAdjacentHTML('beforeend','<div data-chatgpt-selection-message-id="final-current"><div data-markdown-text-style="assistant-message" style="width:600px">本次完整答案</div></div>');
      document.querySelector('[data-turn-key=current] [data-talvt-turn-state]').setAttribute('data-talvt-turn-state','complete');
      const final=tracker.find(nodes());
      const finalSelected=final?.innerText==='本次完整答案' && tracker.isComplete(final);
      const current=document.querySelector('[data-turn-key=current]');
      current.outerHTML=current.outerHTML;
      document.body.insertAdjacentHTML('beforeend','<div hidden>'+document.querySelector('[data-turn-key=current]').outerHTML+'</div>');
      const remounted=tracker.find(nodes());
      const recovered=remounted!==final && remounted?.innerText==='本次完整答案';
      const binding=tracker.binding();
      document.querySelector('[data-turn-key=current]').remove();
      const missingRejected=tracker.find(nodes())===null;
      document.body.insertAdjacentHTML('beforeend',turn('other','别的问题','不是本次回答'));
      const otherRejected=tracker.find(nodes())===null;
      document.body.innerHTML=turn('old','旧问题','旧答案');
      const failedClick=createAnswerTracker(nodes(),{question:'未发送的新问题'});
      document.body.insertAdjacentHTML('beforeend',turn('late','旧问题二','迟到的历史回答'));
      const unsentRejected=failedClick.find(nodes())===null;
      document.body.innerHTML='<div data-message-id="old-u" data-message-author-role="user">相同问题</div><div data-message-id="old-a" data-message-author-role="assistant" style="width:600px">相同答案</div>';
      const legacyNodes=()=>[...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const legacy=createAnswerTracker(legacyNodes(),{question:'相同问题'});
      document.body.insertAdjacentHTML('beforeend','<div data-message-id="new-u" data-message-author-role="user">相同问题</div><div data-message-id="new-a" data-message-author-role="assistant" style="width:600px">相同答案</div>');
      const repeatedAllowed=answerKey(legacy.find(legacyNodes()))==='data-message-id:new-a';
      return {historyRejected,intermediatePending,finalSelected,recovered,missingRejected,otherRejected,unsentRejected,repeatedAllowed,binding};
    })()`)
    assert.deepEqual(checks,{historyRejected:true,intermediatePending:true,finalSelected:true,recovered:true,missingRejected:true,otherRejected:true,unsentRejected:true,repeatedAllowed:true,binding:{revision:'question-bound-v1',questionKey:'data-turn-key:current',answerKey:'data-chatgpt-selection-message-id:final-current'}})
  })

  await t.test('answer wait does not finish on a stable search preamble or return it at timeout',async()=>{
    const result=await evaluate(`(async()=>{
      ${answerKey.toString()}
      ${createAnswerTracker.toString()}
      const assistantNodes=()=>[...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')];
      const stopVisible=()=>false, dismissOverlays=async()=>null,visibleDialogs=()=>[];
      document.body.innerHTML='';
      const tracker=createAnswerTracker([],{question:'本次问题'});
      document.body.innerHTML='<div data-turn-key="current"><div data-talvt-turn-state="streaming"><div data-user-message-bubble>本次问题</div><div data-chatgpt-selection-message-id="preamble"><div data-markdown-text-style="assistant-message" style="width:600px">我来搜索</div></div></div></div>';
      let ticks=0;
      const sleep=async()=>{
        if(++ticks===5) {
          const state=document.querySelector('[data-talvt-turn-state]');
          state.insertAdjacentHTML('beforeend','<div data-chatgpt-selection-message-id="final"><div data-markdown-text-style="assistant-message" style="width:600px">完整答案</div></div>');
          state.setAttribute('data-talvt-turn-state','complete');
        }
      };
      const run=${waitAnswer.toString()};
      const answer=await run(Date.now()+1000,{},Date.now(),tracker);
      document.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state','streaming');
      const expired=await run(Date.now()-1,{},Date.now(),tracker);
      return {text:answer?.text,ticks,expired};
    })()`)
    assert.deepEqual(result,{text:'完整答案',ticks:7,expired:null})
  })

  await t.test('retained screenshot marker cannot authorize a recycled node from another reply',async()=>{
    const identity=await reset()
    await evaluate('document.querySelector("[data-message-id=reply-17]").setAttribute("data-message-id","old-recycled")')
    let shots=0
    chrome.debugger.sendCommand=async(target,method,params)=>{if(method==='Page.captureScreenshot')shots++;return send(method,params)}
    const result=await captureNative(1,rect(identity))
    assert.equal(result.ok,false)
    assert.equal(shots,0)
  })

  await t.test('identity changes after raster discard the image even if the DOM node remains',async()=>{
    const identity=await reset()
    let shots=0
    chrome.debugger.sendCommand=async(target,method,params)=>{
      const result=await send(method,params)
      if(method==='Page.captureScreenshot' && ++shots===1) await evaluate('document.querySelector("[data-message-id=reply-17]").setAttribute("data-message-id","reused-after-shot")')
      return result
    }
    const result=await captureNative(1,rect(identity))
    assert.equal(result.ok,false)
    assert.equal(result.dataUrl,undefined)
    assert.equal(shots,1)
  })

  await t.test('recovers exact message after marker and child index are lost before attach',async()=>{
    const identity=await reset()
    const originalAttach=chrome.debugger.attach
    chrome.debugger.attach=async()=>{await remount()}
    chrome.debugger.sendCommand=normalSend
    try {
      const shot=await captureNative(1,rect(identity))
      assert.equal(shot.ok,true,JSON.stringify(shot))
      assert.equal(shot.info.height,6060)
      assert.equal(await evaluate('!!window.__gptRelayNative'),false)
      assert.equal(await evaluate('document.body.getAttribute("style")'),null)
    } finally {chrome.debugger.attach=originalAttach}
  })

  await t.test('remount during stabilization restores layout and reacquires the same answer',async()=>{
    const identity=await reset()
    let replaced=false
    chrome.debugger.sendCommand=async(target,method,params)=>{
      const response=await send(method,params)
      if(!replaced && method==='Runtime.evaluate' && params.expression.includes('const assets=')) {replaced=true;await remount()}
      return response
    }
    const shot=await captureNative(1,rect(identity))
    assert.equal(shot.ok,true,JSON.stringify(shot))
    assert.equal(shot.info.attempts,2)
    assert.equal(shot.info.retries[0].phase,'stabilize')
    assert.equal(await evaluate('document.querySelector("article").style.minHeight'),'')
    assert.equal(await evaluate('document.body.getAttribute("style")'),null)
  })

  await t.test('remount after raster discards that frame and retries the exact message',async()=>{
    const identity=await reset()
    let shots=0
    chrome.debugger.sendCommand=async(target,method,params)=>{
      const response=await send(method,params)
      if(method==='Page.captureScreenshot' && ++shots===1) await remount()
      return response
    }
    const shot=await captureNative(1,rect(identity))
    assert.equal(shot.ok,true,JSON.stringify(shot))
    assert.equal(shots,2)
    assert.equal(shot.info.retries[0].phase,'after-shot')
    assert.equal(await evaluate('document.body.getAttribute("style")'),null)
  })

  await t.test('missing target never captures a different message with identical text',async()=>{
    const identity=await reset()
    await remount()
    await evaluate('document.querySelector("[data-message-id=reply-17]").setAttribute("data-message-id","unrelated")')
    let shots=0
    chrome.debugger.sendCommand=async(target,method,params)=>{if(method==='Page.captureScreenshot')shots++;return send(method,params)}
    const shot=await captureNative(1,rect(identity))
    assert.equal(shot.ok,false)
    assert.equal(shot.error,'answer-anchor-lost')
    assert.equal(shot.detail.attempts.length,4)
    assert.equal(shots,0)
    assert.equal(await evaluate('document.body.getAttribute("style")'),null)
  })

  await t.test('capture does not collapse the observed flex turn or trigger virtual eviction',async()=>{
    const identity=await reset()
    await evaluate(`(()=>{
      const turn=document.querySelector('article'),height=turn.getBoundingClientRect().height;
      window.evictions=0;window.turnObserver=new ResizeObserver(()=>{
        if(turn.getBoundingClientRect().height<height-.5){window.evictions++;turn.replaceChildren()}
      });window.turnObserver.observe(turn);
    })()`)
    chrome.debugger.sendCommand=normalSend
    const shot=await captureNative(1,rect(identity))
    await evaluate('window.turnObserver.disconnect()')
    assert.equal(shot.ok,true,JSON.stringify(shot))
    assert.equal(await evaluate('window.evictions'),0)
    assert.equal(await evaluate('document.querySelector("article").style.minHeight'),'')
  })

  await t.test('current ChatGPT markup uses selection-message ID and data-turn-key, including hidden duplicates',async()=>{
    // Structure observed through the relay's read-only probe on 2026-11-01.
    const current=`<div data-turn-key="turn-current"><div data-talvt-turn-state="complete"><div style="display:flex;flex-direction:column"><div data-chatgpt-selection-message-id="current-reply"><span hidden></span><div id="answer" data-markdown-text-style="assistant-message" data-gpt-relay-answer="job-test" style="width:600px;margin:24px 0">${bands}</div></div></div></div></div>`
    await evaluate(`document.body.innerHTML=${JSON.stringify(current)}`)
    const identity=await evaluate(`(${describeAnswerAnchor.toString()})(document.getElementById('answer'))`)
    assert.equal(identity.attribute,'data-chatgpt-selection-message-id')
    let replaced=false
    chrome.debugger.sendCommand=async(target,method,params)=>{
      const response=await send(method,params)
      if(!replaced && method==='Runtime.evaluate' && params.expression.includes('const assets=')) {
        replaced=true
        await evaluate(`document.body.innerHTML=${JSON.stringify('<div hidden>'+current+'</div>'+current.replace(' data-gpt-relay-answer="job-test"',''))}`)
      }
      return response
    }
    const shot=await captureNative(1,rect(identity))
    assert.equal(shot.ok,true,JSON.stringify(shot))
    assert.equal(shot.info.attempts,2)
    assert.equal(shot.info.height,6060)
    assert.equal(await evaluate('document.body.getAttribute("style")'),null)
    assert.equal(await evaluate('[...document.querySelectorAll("[data-turn-key]")].every(n=>!n.style.minHeight)'),true)
    const rows=await evaluate(`(async()=>{const img=new Image();img.src=${JSON.stringify(shot.dataUrl)};await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return Array.from({length:40},(_,i)=>[...ctx.getImageData(Math.round(60*${dpr}),Math.round((30+i*150+70)*${dpr}),1,1).data])})()`)
    for(let i=0;i<40;i++) assert.deepEqual(rows[i],[30+i*4,80+i*2,130,255],`Recovered answer lost band ${i}`)
  })

  await t.test('real composer pauses a slow image then sends the same draft exactly once without opening a chat',async()=>{
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII='
    const scenario=await evaluate(`(async()=>{
      document.body.innerHTML='<button aria-label="新聊天" id="new">New</button><form><div data-composer-attachments></div><div id="editor" contenteditable="true"></div><input type="file" accept="image/*" multiple><button id="send" type="button">Send</button></form>';
      const UPLOAD_DRAFT_KEY='__gptRelayUploadDraft', memory=new Map();
      const sessionStorage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)};
      const sleep=ms=>new Promise(r=>setTimeout(r,Math.min(ms,20))),seen=new WeakSet(),ANSWER_WAIT_MS=300000;
      ${attachmentScope.toString()}
      ${attachmentState.toString()}
      ${waitAttachments.toString()}
      ${readUploadDraft.toString()}
      ${saveUploadDraft.toString()}
      ${clearUploadDraft.toString()}
      ${verifyUploadDraft.toString()}
      ${describeAnswerAnchor.toString()}
      const realUpload=${uploadAttachments.toString()};
      const counters={files:0,uploads:0,sends:0,newChats:0,claims:0};
      const chrome={runtime:{sendMessage:async msg=>{
        if(msg.type==='attachment'){counters.files++;return {ok:true,dataUrl:'data:image/png;base64,${png}'}}
        if(msg.action==='claim-send')counters.claims++;
        return {ok:true};
      }}};
      const getEditor=()=>document.querySelector('#editor');
      const findComposer=getEditor,composerText=el=>el.innerText,findSend=()=>document.querySelector('#send');
      const uploadAttachments=(job,composer,sels,options)=>realUpload(job,composer,sels,{...options,timeoutMs:80,sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,20)))});
      const waitSendReady=async()=>findSend(),setText=(el,text)=>{el.innerText=text;return true};
      ${answerKey.toString()}
      ${createAnswerTracker.toString()}
      const assistantNodes=()=>[...document.querySelectorAll('[data-markdown-text-style="assistant-message"]')];
      const dismissOverlays=async()=>null,scrollToBottom=()=>{},pressEnter=()=>{throw new Error('unexpected enter')};
      let answerMissing=false,viewportCalls=0;
      const waitAnswer=async(deadline,sels,sentAt,tracker)=>answerMissing?null:({node:tracker.find(assistantNodes())}),collectImages=async()=>[],richness=()=>({}),extractMd=()=> '回答';
      const screenshotNode=async()=>({dataUrl:'test'}),screenshotViewport=async()=>{viewportCalls++;return 'old-page'},dumpReport=()=>({});
      const run=${runAsk.toString()};
      document.querySelector('#new').onclick=()=>counters.newChats++;
      document.querySelector('input').onchange=()=>{
        counters.uploads++;
        const area=document.querySelector('[data-composer-attachments]');area.setAttribute('data-state','uploading');
        const img=new Image();img.alt='a.png';img.src='data:image/png;base64,${png}';area.append(img);
        setTimeout(()=>area.removeAttribute('data-state'),250);
      };
      // The busy indicator can be on the attachment area itself.
      const job={id:'upload-real',text:'看这张图',newChat:false,attachments:[{name:'a.png',type:'image/png',size:atob('${png}').length}]};
      document.querySelector('#send').onclick=()=>{counters.sends++;getEditor().innerText='';document.querySelector('[data-composer-attachments]').replaceChildren();document.body.insertAdjacentHTML('beforeend','<div data-turn-key="new-turn"><div data-talvt-turn-state="complete"><div data-user-message-bubble>看这张图</div><div data-chatgpt-selection-message-id="new-answer"><div style="width:600px" data-markdown-text-style="assistant-message">回答</div></div></div></div>')};
      const paused=await run(job,{});
      const replacement=await run({...job,id:'new-job',newChat:true},{});
      await new Promise(r=>setTimeout(r,300));
      // React remounts the composer while the upload is pending.
      const old=getEditor(),fresh=old.cloneNode(true);old.replaceWith(fresh);
      const resumed=await run({...job,resumeUpload:true,newChat:false},{});
      const outcome={paused:paused.status,blocked:replacement.error,resumed:resumed.status,draft:readUploadDraft(),...counters};
      answerMissing=true;
      const absent=await run({...job,id:'no-answer',attachments:[]},{});
      outcome.noAnswer={error:absent.error,hasScreenshot:!!absent.screenshot,viewportCalls};
      return outcome;
    })()`)
    assert.deepEqual(scenario,{paused:'paused',blocked:'composer-busy',resumed:'ok',draft:null,files:1,uploads:1,sends:1,newChats:0,claims:1,noAnswer:{error:'no-answer',hasScreenshot:false,viewportCalls:0}})
  })

  await t.test('50,000 CSS pixel answer continues across long images without missing or repeated pixel rows',async()=>{
    const long=Array.from({length:250},(_,i)=>`<div style="height:200px;background:rgb(${20+i%200},${40+i%150},${60+i%100})">${i===249?'END OF CURRENT ANSWER':'Row '+i}</div>`).join('')
    await evaluate(`document.body.innerHTML=${JSON.stringify('<div data-message-id="long-reply"><section id="answer" data-message-author-role="assistant" data-gpt-relay-answer="job-test">'+long+'</section></div>')}`)
    const identity=await evaluate(`(${describeAnswerAnchor.toString()})(document.getElementById('answer'))`)
    let count=0
    chrome.debugger.sendCommand=async(target,method,params)=>{if(method==='Page.captureScreenshot')count++;return send(method,params)}
    const output=await captureNative(1,rect(identity))
    assert.equal(output.ok,true,JSON.stringify(output.info || output.detail))
    assert.equal(output.info.pages,3)
    assert.equal(output.dataUrls.length,3)
    assert.equal(output.dataUrl,undefined,'never expose only the first page as a complete answer')
    assert.equal(output.info.pageRanges[0].startPx,0)
    assert.equal(output.info.pageRanges.at(-1).endPx,Math.ceil(50000*dpr))
    assert.equal(output.info.slices,count)
    let covered=0
    for(let i=0;i<output.dataUrls.length;i++) {
      const range=output.info.pageRanges[i]
      assert.equal(range.startPx,covered)
      assert.ok(range.heightPx<=25000)
      const pixels=await evaluate(`(async()=>{
        const image=await createImageBitmap(await (await fetch(${JSON.stringify(output.dataUrls[i])})).blob());
        const c=new OffscreenCanvas(image.width,image.height),ctx=c.getContext('2d');ctx.drawImage(image,0,0);
        const pad=Math.round(${output.info.padding*dpr}),start=${range.startPx},end=${range.endPx};
        const rows=ctx.getImageData(image.width-pad-10,pad,1,end-start).data;
        let mismatches=0;
        for(let r=0;r<end-start;r++) {const n=Math.floor((start+r)/(${dpr}*200));const expected=[20+n%200,40+n%150,60+n%100,255];if(expected.some((v,k)=>rows[r*4+k]!==v))mismatches++;}
        return {width:image.width,height:image.height,mismatches};
      })()`)
      assert.equal(pixels.height,range.heightPx)
      assert.equal(pixels.mismatches,0,`bad rows on page ${i+1}`)
      covered=range.endPx
    }
    assert.equal(await evaluate('document.body.getAttribute("style")'),null)
    await evaluate('window.pagesResumed=false;setTimeout(()=>window.pagesResumed=true,0)')
    await new Promise(resolve=>setTimeout(resolve,80))
    assert.equal(await evaluate('window.pagesResumed'),true)
    // A failure on a later tile cannot publish only the prefix as success.
    let tiles=0
    chrome.debugger.sendCommand=async(target,method,params)=>{
      if(method==='Page.captureScreenshot' && ++tiles===2) throw new Error('later tile failed')
      return send(method,params)
    }
    await assert.rejects(captureNative(1,rect(identity)),/later tile failed/)
    assert.equal(await evaluate('document.body.getAttribute("style")'),null)
  })
})
