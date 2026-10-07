import { CHOICES, higherOf, pickOf, type Choice, type Probabilities } from '../hooks/policy'

export const QUANTILES = [0.95, 0.96, 0.97, 0.98, 0.99] as const

export function mappedLevel(level: Choice, effort: Probabilities, work: Probabilities, q: number): Choice {
  if (!CHOICES.includes(level) || !QUANTILES.some(value => value === q)) {
    throw new Error('Unsupported level or quantile')
  }
  for (const probabilities of [effort, work]) {
    if (!probabilities || CHOICES.some(key => {
      const p = probabilities[key]
      return typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1
    })) throw new Error('Incomplete distribution')
  }
  const selected = higherOf(level, higherOf(pickOf(effort, q, 'low', 'xhigh'), pickOf(work, q, 'low', 'xhigh')))
  if (selected === 'max') throw new Error('Manual max is outside the fitted policy')
  return selected
}
