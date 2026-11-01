import { sleep } from './http.mjs'
import { resolveAnswerAnchor } from '../shared/answer-anchor.mjs'
import { planCapturePages, composeCapturePages } from './capture-pages.mjs'

/** One native raster of the original answer. No viewport resize or scrolling tiles. */
export async function captureNative(tabId, rect, {compose=composeCapturePages} = {}) {
  const target = { tabId }
  // A background tab can stop producing frames, and then Page.captureScreenshot
  // never resolves. Activate it first; the user expects this tab to be driven.
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.active) await chrome.tabs.update(tabId, { active: true })
  } catch {}
  // One raster with a bounded wait; a hung raster is retried once, not retried
  // by the whole capture pipeline (which would re-run the layout dance).
  const raster = async clip => {
    for (let attempt = 0; ; attempt++) {
      let timer
      try {
        return await Promise.race([
          chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: true, fromSurface: true, clip,
          }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('capture-raster-timeout')), attempt ? 20000 : 15000) }),
        ])
      } catch (error) {
        if (attempt >= 1 || !/capture-raster-timeout/.test(error.message)) throw error
        await sleep(400)
      } finally { clearTimeout(timer) }
    }
  }
  if (!/^\[data-gpt-relay-answer="[a-zA-Z0-9_-]+"\]$/.test(rect.selector || '')) return { ok: false, error: 'missing-answer-anchor' }
  const selector = JSON.stringify(rect.selector)
  const evaluate = async expression => {
    const response = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'capture evaluation failed')
    return response.result?.value
  }
  const prepare = `(() => {
    const marked=document.querySelector(${selector});
    const box=marked?.getBoundingClientRect();
    const el = ${rect.identity ? `(${resolveAnswerAnchor.toString()})(${JSON.stringify(rect.identity)})` : 'marked?.isConnected && box.width>100 && box.height>0 ? marked : null'};
    if (!el || !el.isConnected) return { error: 'answer-anchor-lost' };
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 1) return { error: 'no-visible-element' };
    const originals = new Map(), scrolls = [];
    const set = (n, key, value) => { if (!originals.has(n)) originals.set(n,n.getAttribute('style')); n.style.setProperty(key,value,'important'); };
    const padding = Math.max(24, Math.min(48, Math.round(r.width * .05)));
    const s = window.__gptRelayNative = { el, originals, scrolls, placeholder: null, width: r.width, padding, started: performance.now() };
    s.restore = () => {
      clearTimeout(s.timer);
      for (const [n,value] of s.originals) { if (value === null) n.removeAttribute('style'); else n.setAttribute('style',value); }
      s.placeholder?.remove();
      for (const [n,x,y] of s.scrolls) { if (n.scrollLeft !== x) n.scrollLeft=x; if (n.scrollTop !== y) n.scrollTop=y; }
      for (const [n,value] of s.originals) if (value === null && !n.getAttribute('style')) n.removeAttribute('style');
      if (window.__gptRelayNative === s) window.__gptRelayNative=null;
    };
    // Also restore if DevTools disconnects this extension mid-capture.
    s.timer = setTimeout(s.restore,25000);
    let background = 'rgb(255,255,255)';
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundColor && cs.backgroundColor !== 'transparent' && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') { background = cs.backgroundColor; break; }
    }
    s.background = background;
    set(document.documentElement,'background-color',background);
    // A same-size placeholder keeps the virtual turn's layout height unchanged.
    // Pin the enclosing turn before taking the answer out of flow. A bare div
    // cannot preserve flex/grid sizing or the answer's collapsing margins.
    const turn=el.closest('article,[data-testid^="conversation-turn"],[data-turn-id],[data-turn-key]');
    if (turn) for(let n=el.parentElement;n && n!==turn.parentElement;n=n.parentElement) {
      const cs=getComputedStyle(n), box=n.getBoundingClientRect();
      if (cs.display==='contents') continue;
      const inset=cs.boxSizing==='border-box'?0:parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom)+parseFloat(cs.borderTopWidth)+parseFloat(cs.borderBottomWidth);
      set(n,'min-height',Math.max(0,box.height-inset)+'px');
    }
    const placeholder = document.createElement('div');
    placeholder.style.cssText = 'height:' + r.height + 'px;width:' + r.width + 'px;visibility:hidden;pointer-events:none;flex-shrink:0';
    const layout=getComputedStyle(el);
    for(const key of ['margin-top','margin-bottom','margin-left','margin-right','align-self','grid-area','order']) placeholder.style.setProperty(key,layout.getPropertyValue(key));
    el.before(placeholder); s.placeholder = placeholder;
    for (let n = el.parentElement; n; n = n.parentElement) {
      scrolls.push([n,n.scrollLeft,n.scrollTop]);
      set(n,'transform','none'); set(n,'filter','none'); set(n,'perspective','none');
      set(n,'contain','none'); set(n,'content-visibility','visible'); set(n,'will-change','auto');
      set(n,'clip-path','none');
    }
    set(document.body,'visibility','hidden');
    set(el,'visibility','visible'); set(el,'position','fixed');
    set(el,'top',padding+'px'); set(el,'left',padding+'px');
    set(el,'width',r.width+'px'); set(el,'min-width',r.width+'px'); set(el,'max-width',r.width+'px');
    set(el,'box-sizing','border-box'); set(el,'margin','0'); set(el,'transform','none');
    set(el,'height','auto'); set(el,'max-height','none'); set(el,'overflow','visible');
    set(el,'z-index','2147483647'); set(el,'background-color',background);
    set(el,'content-visibility','visible'); set(el,'contain','none');
    set(el,'animation','none'); set(el,'transition','none');
    for (const n of el.querySelectorAll('*')) {
      const cs = getComputedStyle(n);
      if (cs.contentVisibility === 'auto') set(n,'content-visibility','visible');
      if (cs.position === 'sticky' || cs.position === 'fixed') set(n,'position','static');
      if (cs.animationName !== 'none') set(n,'animation','none');
      if (cs.transitionDuration !== '0s') set(n,'transition','none');
    }
    return { background, padding };
  })()`
  const measure = `(() => {
    const s = window.__gptRelayNative;
    if (!s) return {error:'capture-session-lost'};
    if (!s.el.isConnected) return {error:'answer-node-detached'};
    if (${rect.identity ? `(${resolveAnswerAnchor.toString()})(${JSON.stringify(rect.identity)})!==s.el` : 'false'}) return {error:'answer-identity-mismatch'};
    const r = s.el.getBoundingClientRect();
    return { width:r.width, height:r.height, top:r.top, left:r.left, scrollX:window.scrollX, scrollY:window.scrollY,
      viewportWidth:window.innerWidth, viewportHeight:window.innerHeight, dpr:window.devicePixelRatio || 1 };
  })()`
  const restore = 'window.__gptRelayNative?.restore()'
  const start = Date.now()
  let captured=null
  let scriptsSuspended=false
  const resumeScripts=async()=>{
    if(scriptsSuspended) {
      await chrome.debugger.sendCommand(target,'Emulation.setScriptExecutionDisabled',{value:false})
      scriptsSuspended=false
    }
  }
  await chrome.debugger.attach(target, '1.3')
  try {
    let setup=null
    const attempts=[]
    const recover=async(attempt,phase,error,cause)=>{
      attempts.push({attempt,phase,error,...(cause?{cause}: {})});
      await evaluate(restore); setup=null;
      await resumeScripts();
      await sleep(250);
    }
    for(let attempt=1;attempt<=4;attempt++) {
      if(!setup) {
        setup=await evaluate(prepare)
        if(!setup || setup.error) {
          const error=setup?.error || 'capture-prepare-failed'
          if(error!=='answer-anchor-lost') return {ok:false,error,detail:{attempts}}
          await recover(attempt,'prepare',error); continue
        }
        await evaluate(`(async()=>{
      const s=window.__gptRelayNative;
      const assets=[document.fonts?.ready,...[...s.el.querySelectorAll('img')].map(img=>img.decode().catch(()=>{}))];
      await Promise.race([Promise.allSettled(assets),new Promise(resolve=>setTimeout(resolve,2500))]);
      return true;
        })()`)
      }
      let previous=null,state=null,stable=0
      let lost=false,cause=''
      for(let i=0;i<14;i++) {
        await sleep(100)
        const current=await evaluate(measure)
        if(!current || current.error) {lost=true;cause=current?.error;break}
        stable=previous && ['width','height','top','left'].every(key=>Math.abs(current[key]-previous[key])<.5)?stable+1:0
        if(stable>=2){state=current;break}
        previous=current
      }
      if(lost){await recover(attempt,'stabilize','answer-anchor-lost',cause);continue}
      if(!state){attempts.push({attempt,error:'layout-unstable'});continue}
      // Page.captureScreenshot can trigger virtual-list observers. Keep app
      // callbacks suspended only for the final measurement, raster and check.
      // CDP evaluation still works; no viewport or device metrics are changed.
      scriptsSuspended=true
      await chrome.debugger.sendCommand(target,'Emulation.setScriptExecutionDisabled',{value:true})
      const frozen=await evaluate(measure)
      if(!frozen || frozen.error){await recover(attempt,'before-shot','answer-anchor-lost',frozen?.error);continue}
      if(['width','height','top','left'].some(key=>Math.abs(frozen[key]-state[key])>.5)) {
        await recover(attempt,'before-shot','layout-changed');continue
      }
      state=frozen
      const width=Math.ceil(state.width+setup.padding*2)
      const height=Math.ceil(state.height+setup.padding*2)
      if(height*state.dpr>8000 || width*height*state.dpr*state.dpr>32_000_000) {
        const plan=planCapturePages(state.height,state.width,setup.padding,state.dpr)
        const pages=[]
        let invalid=''
        for(const page of plan.pages) {
          const tiles=[]
          for(let offset=page.startPx;offset<page.endPx;offset+=8000) {
            if(Date.now()-start>90000) throw new Error('capture-pages-timeout')
            const endPx=Math.min(page.endPx,offset+8000)
            await evaluate(`(() => {const s=window.__gptRelayNative;if(s?.el.isConnected)s.el.style.setProperty('top',${JSON.stringify(-offset/state.dpr+'px')},'important');})()`)
            const before=await evaluate(measure)
            if(!before || before.error){invalid=before?.error || 'capture-session-lost';break}
            if(Math.abs(before.height-state.height)>.5 || Math.abs(before.width-state.width)>.5){invalid='layout-changed';break}
            let tile
            try {
              tile=await raster({x:state.scrollX,y:state.scrollY,width:plan.widthPx/state.dpr,height:(endPx-offset)/state.dpr,scale:1})
            } catch(error) {
              if(!/capture-raster-timeout/.test(error.message)) throw error
              invalid='capture-raster-timeout'
              break
            }
            const after=await evaluate(measure)
            if(!after || after.error){invalid=after?.error || 'capture-session-lost';break}
            if(['width','height','top','left','viewportWidth','viewportHeight'].some(key=>Math.abs(after[key]-before[key])>.5)){invalid='layout-changed';break}
            tiles.push({startPx:offset,endPx,dataUrl:'data:image/png;base64,'+tile.data})
          }
          if(invalid) break
          pages.push({...page,tiles})
        }
        if(invalid){await recover(attempt,'capture-pages',invalid==='layout-changed'?invalid:'answer-anchor-lost',invalid);continue}
        // Compose outside the suspended page and after restoring its layout.
        captured={pages,plan,background:setup.background,attempt,retries:attempts}
        break
      }
      const shot=await raster({x:state.scrollX,y:state.scrollY,width,height,scale:1})
      const after=await evaluate(measure)
      if(!after || after.error){await recover(attempt,'after-shot','answer-anchor-lost',after?.error);continue}
      if(['width','height','top','left','viewportWidth','viewportHeight'].some(key=>Math.abs(after[key]-state[key])>.5)) {
        attempts.push({attempt,error:'layout-changed',before:{width:state.width,height:state.height},after:{width:after.width,height:after.height}})
        await resumeScripts()
        await sleep(150)
        continue
      }
      return {ok:true,dataUrl:'data:image/png;base64,'+shot.data,
        info:{width,height,contentHeight:state.height,padding:setup.padding,complete:true,dpr:state.dpr,slices:1,pages:1,mode:'native-answer',revision:'capture-pages-v4',attempts:attempt,retries:attempts,durationMs:Date.now()-start}}
    }
    if(!captured) return {ok:false,error:attempts.at(-1)?.error==='answer-anchor-lost'?'answer-anchor-lost':'answer-layout-unstable-after-retries',detail:{revision:'capture-pages-v4',attempts,durationMs:Date.now()-start}}
  } finally {
    await evaluate(restore).catch(()=>{})
    await resumeScripts().catch(()=>{})
    await chrome.debugger.detach(target).catch(()=>{})
  }
  const {pages,plan,background,attempt,retries}=captured
  const dataUrls=await compose(pages,{...plan,background})
  return {ok:true,dataUrls,info:{revision:'capture-pages-v4',mode:'native-answer-pages',complete:true,
    width:plan.widthPx/plan.dpr,contentHeight:plan.contentPx/plan.dpr,dpr:plan.dpr,padding:plan.paddingPx/plan.dpr,
    pages:pages.length,slices:pages.reduce((n,page)=>n+page.tiles.length,0),
    pageRanges:plan.pages,attempts:attempt,retries,durationMs:Date.now()-start}}
}
