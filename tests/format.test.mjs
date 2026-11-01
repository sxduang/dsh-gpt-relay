import test from 'node:test'
import assert from 'node:assert/strict'
import { toWechat, splitChunks } from '../relay/format.mjs'

test('Chinese Markdown formatting preserves links, table data and code fences', () => {
  const source = '## 结论\n\n**重点** [来源](https://example.org)\n\n| 指标 | 值 |\n| --- | --- |\n| 基因 | 3000 |\n\n- 一\n- 二\n\n```r\nx <- 1\n```'
  assert.equal(toWechat(source), '【结论】\n\n重点 来源（https://example.org）\n指标｜值\n基因｜3000\n· 一\n· 二\n\n```r\nx <- 1\n```')
})

test('chunks prefer paragraph boundaries and split oversized paragraphs without loss', () => {
  assert.deepEqual(splitChunks('甲乙\n\n丙丁\n\n戊己庚辛壬癸', 4), ['甲乙', '丙丁', '戊己庚辛', '壬癸'])
  assert.deepEqual(splitChunks('ab\n\ncd', 6), ['ab\n\ncd'])
  assert.deepEqual(splitChunks('', 10), [])
})
