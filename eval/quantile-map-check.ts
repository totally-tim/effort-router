import { strict as assert } from 'node:assert'
import { CHOICES, clamp, routeOf } from '../hooks/policy'
import type { Answer, ClassifyInput } from '../hooks/classify'
import { mappedLevel, QUANTILES } from './quantile-map'

const distributions = [
  { low: 1, medium: 0, high: 0, xhigh: 0 },
  { low: .95, medium: .01, high: .01, xhigh: .03 },
  { low: .5, medium: .45, high: .04, xhigh: .01 },
  { low: 0, medium: 0, high: .99, xhigh: .01 },
  { low: .25, medium: .25, high: .25, xhigh: .25 },
  { low: .24, medium: .25, high: .25, xhigh: .25 },
  { low: 0, medium: 0, high: 0, xhigh: 1 },
]
const inputs: ClassifyInput[] = [
  { request: 'Explain addition.' },
  { request: 'ultrathink about addition.' },
  { request: 'Continue it.', continuesTask: true },
]
let checks = 0
for (const effort of distributions) for (const work of distributions) {
  for (const input of inputs) for (const baseline of CHOICES) for (const sufficient of [false, true]) {
    const answer: Answer = { choice: 'low', probabilities: effort, workProbabilities: work,
      confidence: .9, context: sufficient ? 'sufficient' : 'missing_evidence',
      contextSufficient: sufficient, relation: 'new' }
    for (const cap of [undefined, ...CHOICES]) {
      const routed = (q: number) => {
        const r = routeOf(answer, input, baseline, q, 'low', 'xhigh')
        const level = cap && r.contextHeld ? clamp(cap, r.unheld, r.level) : r.level
        assert.notEqual(level, 'max')
        if (level === 'max') throw new Error('Unexpected manual level')
        return level
      }
      const original = routed(.95)
      for (const q of QUANTILES) {
        assert.equal(mappedLevel(original, effort, work, q), routed(q))
        checks++
      }
    }
  }
}
const complete = distributions[0]!
assert.throws(() => mappedLevel('low', { low: 1 }, complete, .95))
assert.throws(() => mappedLevel('low', { ...complete, low: NaN }, complete, .95))
assert.throws(() => mappedLevel('low', complete, complete, 1))
assert.throws(() => mappedLevel('low', complete, complete, .94))
console.log(JSON.stringify({ complete: true, routeAndNotificationCapComparisons: checks,
  scope: 'Fixed saved context, low floor, xhigh ceiling. Manual and yielded turns bypass the fitted policy.' }))
