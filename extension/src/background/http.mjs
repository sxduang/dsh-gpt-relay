export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function jsonFetch(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) throw new Error(`worker ${res.status}`)
  return res.json()
}
