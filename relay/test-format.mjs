import { toWechat, splitChunks } from './format.mjs'

const md = [
  '## 一、结论',
  '',
  '**要点**：平均 UMI 约少 20 倍，见 [10x 官方](https://www.10xgenomics.com/cn/) 与 [原文](https://example.org/paper)。',
  '',
  '| 指标 | scRNA | 空间 |',
  '| --- | --- | --- |',
  '| UMI | 10000 | 500 |',
  '| 基因数 | 3000 | 600 |',
  '',
  '- 第一点',
  '- 第二点',
  '',
  '```r',
  'x <- 1',
  '```',
].join('\n')

const out = toWechat(md)
console.log(out)
console.log('--- 字符数 ---', out.length, '分块', splitChunks(out, 60).length)
