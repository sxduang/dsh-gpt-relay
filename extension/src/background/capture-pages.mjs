// Physical pixels: each delivered image is about as long as the existing long
// screenshot. Browser raster tiles remain smaller than compositor texture limits.
export function planCapturePages(contentHeight, contentWidth, padding, dpr) {
  const widthPx=Math.ceil((contentWidth+2*padding)*dpr)
  const paddingPx=Math.round(padding*dpr)
  const contentPx=Math.ceil(contentHeight*dpr)
  const maxHeightPx=Math.min(25000,Math.floor(32_000_000/widthPx))
  const capacity=maxHeightPx-2*paddingPx
  if (![widthPx,contentPx,capacity,dpr].every(n=>Number.isFinite(n) && n>0)) throw new Error('invalid-capture-dimensions')
  const pages=[]
  for(let startPx=0;startPx<contentPx;startPx+=capacity) {
    const endPx=Math.min(contentPx,startPx+capacity)
    pages.push({startPx,endPx,heightPx:endPx-startPx+2*paddingPx})
  }
  return {widthPx,paddingPx,contentPx,dpr,pages}
}

// Lossless assembly of native screenshot pixels, never HTML/text redrawing.
// Self-contained so the browser integration tests run the identical compositor.
export async function composeCapturePages(pages, meta) {
  const result=[]
  let covered=0
  for(const page of pages) {
    if(page.startPx!==covered || page.endPx<=page.startPx) throw new Error('screenshot-page-gap')
    const canvas=new OffscreenCanvas(meta.widthPx,page.heightPx)
    try {
      const ctx=canvas.getContext('2d')
      ctx.fillStyle=meta.background
      ctx.fillRect(0,0,canvas.width,canvas.height)
      let offset=page.startPx
      for(const tile of page.tiles) {
        if(tile.startPx!==offset || tile.endPx<=tile.startPx) throw new Error('screenshot-tile-gap')
        const bitmap=await createImageBitmap(await (await fetch(tile.dataUrl)).blob())
        try {
          if(bitmap.width!==meta.widthPx || bitmap.height!==tile.endPx-tile.startPx) throw new Error('screenshot-raster-size-mismatch')
          ctx.drawImage(bitmap,0,meta.paddingPx+tile.startPx-page.startPx)
        } finally {bitmap.close()}
        offset=tile.endPx
      }
      if(offset!==page.endPx) throw new Error('screenshot-page-incomplete')
      const bytes=new Uint8Array(await (await canvas.convertToBlob({type:'image/png'})).arrayBuffer())
      let binary=''
      for(let i=0;i<bytes.length;i+=32768) binary+=String.fromCharCode(...bytes.subarray(i,i+32768))
      result.push('data:image/png;base64,'+btoa(binary))
      covered=page.endPx
    } finally {canvas.width=1;canvas.height=1}
  }
  if(covered!==meta.contentPx) throw new Error('screenshot-answer-incomplete')
  return result
}
