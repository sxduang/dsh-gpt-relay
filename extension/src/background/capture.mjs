// Compatibility entrypoint. All captures now require a specific answer anchor.
import { captureNative } from './native-capture.mjs'
export async function captureElement(tabId, rect) {
  return captureNative(tabId, rect)
}
