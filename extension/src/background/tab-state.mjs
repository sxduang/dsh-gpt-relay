/** Observe occupancy only. Never toggle DevTools or detach another debugger. */
export async function checkTabInput(tabId) {
  if (!Number.isInteger(tabId)) return {ok:false,error:'no tab'}
  const targets=await chrome.debugger.getTargets()
  if(targets.some(target=>target.tabId===tabId && target.attached)) {
    return {ok:false,error:'debugger-busy',detail:'页面正被开发者工具或其他调试器占用，已停止输入，避免误操作。'}
  }
  return {ok:true}
}
