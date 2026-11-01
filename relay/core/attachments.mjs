import fs from 'node:fs/promises'
import path from 'node:path'

export const MAX_IMAGES = 4
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024
export const IMAGE_REQUEST_LIMIT = 28 * 1024 * 1024

function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }) }
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  throw invalid('图片格式不支持，请使用 PNG、JPEG 或 WebP 原图')
}

export function validateAttachments(input = []) {
  if (!Array.isArray(input) || input.length > MAX_IMAGES) throw invalid('每次最多上传 4 张图片')
  let total = 0
  return input.map((image, index) => {
    if (!image || typeof image.data !== 'string' || image.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw invalid('图片内容不是有效的 base64')
    if (image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw invalid('单张图片不能超过 10 MiB')
    const bytes = Buffer.from(image.data, 'base64')
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw invalid('图片为空或超过 10 MiB')
    total += bytes.length
    if (total > MAX_TOTAL_BYTES) throw invalid('图片合计不能超过 20 MiB')
    const type = imageType(bytes)
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type]
    const stem = path.basename(String(image.name || `image-${index + 1}`)).replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'image'
    return { name: `${stem}.${ext}`, type, size: bytes.length, bytes }
  })
}

export async function loadImageFiles(files) {
  if (files.length > MAX_IMAGES) throw invalid('每次最多上传 4 张图片')
  const images = []
  let total = 0
  for (const file of files) {
    const handle = await fs.open(path.resolve(file), 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile() || !info.size || info.size > MAX_IMAGE_BYTES) throw invalid(`图片为空、不是文件或超过 10 MiB：${file}`)
      total += info.size
      if (total > MAX_TOTAL_BYTES) throw invalid('图片合计不能超过 20 MiB')
      const bytes = await handle.readFile()
      images.push({ name: path.basename(file), data: bytes.toString('base64') })
    } finally { await handle.close() }
  }
  validateAttachments(images)
  return images
}

export function attachmentMetadata(attachments) {
  return attachments.map(({ name, type, size }) => ({ name, type, size }))
}

export function releaseAttachments(job) {
  for (const image of job.attachments || []) image.bytes = null
}
