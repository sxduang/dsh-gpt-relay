export function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

export function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        chunks = []
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('request aborted')))
  })
}
