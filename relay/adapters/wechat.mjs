import { spawn as spawnProcess } from 'node:child_process'

/** Keep the existing plugin CLI as the only owner of WeChat delivery and its quota ledger. */
export function createWechatSender({ config, log = () => {}, spawn = spawnProcess }) {
  let sendChain = Promise.resolve()

  function sendOnce(text, file) {
    return new Promise((resolve) => {
      const args = [config.wechatCli]
      if (text) args.push(text)
      if (file) args.push('--file', file)
      if (!text && !file) return resolve({ code: 2, stderr: 'nothing to send' })
      const child = spawn(config.node, args, {
        env: { ...process.env, DSH_HOME: config.dshHome },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stderr = ''
      child.stdout.on('data', () => {})
      child.stderr.on('data', (d) => (stderr += d))
      child.on('error', (err) => resolve({ code: -1, stderr: String(err) }))
      child.on('close', (code) => resolve({ code, stderr }))
    })
  }

  return function sendWechat(text, file) {
    sendChain = sendChain.then(async () => {
      const res = await sendOnce(text, file)
      log('wechat-send', { code: res.code, chars: (text || '').length, file: file || '', stderr: res.stderr.slice(0, 200) })
      return res
    })
    return sendChain
  }
}
