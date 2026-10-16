import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const complete = {
  reason: 'answer' as const,
  answer: 'ok',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
}

const usage = (tokens: number) => ({
  startedAt: 0,
  context: { tokens, window: 1000000, percent: Math.round(tokens / 10000) },
  rateLimits: [],
})

const configured = { isEnabled: true, isConfigured: true, thresholdK: 350, stepK: 100 }

type Ask = { questions: { question: string; header: string; options: { label: string }[] }[] }
const answer = (e: Ask, label: string) => ({
  result: { questions: e.questions, answers: { [e.questions[0].question]: label } },
})

// What `$.command.list()` returns beneath the mod: with or without a handoff skill.
const listing = (on: On, name?: string) =>
  on('command.list', () => ({
    value: name ? [{ name, description: 'x', source: 'plugin' as const }] : [],
  }))

test('stays quiet below the threshold', async ($, on) => {
  let asked = 0
  const clock = mock.clock(on)
  mock.store(on, { config: configured })
  listing(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage(172_000) }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked++
    return { deny: 'no dialog expected' }
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(0)
})

test('asks above the threshold and compacts on "Compact"', async ($, on) => {
  let asked = 0
  let compacted = 0
  const clock = mock.clock(on)
  mock.store(on, { config: configured })
  listing(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage(360_000) }))
  on('session.compact', () => {
    compacted++
    return { skip: 'test' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked++
    return answer(e, 'Compact')
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(1)
  expect(compacted).toBe(1)
})

test('uses the stored threshold, not the default', async ($, on) => {
  let asked = 0
  const clock = mock.clock(on)
  mock.store(on, { config: { ...configured, thresholdK: 200 } })
  listing(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage(250_000) }))
  on('session.compact', () => ({ skip: 'test' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked++
    return answer(e, 'Compact')
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(1)
})

test('first run asks threshold and step once, then remembers them', async ($, on) => {
  const headers: string[] = []
  const clock = mock.clock(on)
  mock.store(on)
  listing(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage(10_000) }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    headers.push(e.questions[0].header)
    return answer(e, e.questions[0].header === 'Threshold' ? '200k' : '50k')
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(headers).toEqual(['Threshold', 'Step'])
  const shown = (await $.command.run({ command: 'context-guard', args: '' })).text
  expect(shown).toContain('200k')
  expect(shown).toContain('50k')
  expect(shown).not.toContain('not confirmed')
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(headers.length).toBe(2)
})

test('a dismissed first-run dialog keeps the defaults and is not asked again', async ($, on) => {
  let asked = 0
  const clock = mock.clock(on)
  mock.store(on)
  listing(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage(10_000) }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked++
    return { deny: 'dismissed' }
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  const shown = (await $.command.run({ command: 'context-guard', args: '' })).text
  expect(shown).toContain('350k')
  expect(shown).toContain('100k')
  expect(shown).not.toContain('not confirmed')
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(1)
})

test('/context-guard sets, shows, disables and resets', async ($, on) => {
  mock.store(on, { config: configured })
  const run = async (args: string) => (await $.command.run({ command: 'context-guard', args })).text

  expect(await run('')).toContain('350k')
  expect(await run('300 75')).toContain('300k')
  expect(await run('')).toContain('300k tokens, then every 75k')
  expect(await run('nonsense')).toContain('Usage')
  expect(await run('0 10')).toContain('Usage')
  expect(await run('off')).toContain('off')
  expect(await run('')).toContain('is off')
  expect(await run('on')).toContain('on')
  await run('reset')
  expect(await run('')).toContain('not confirmed')
})

test('the Handoff option is left out when no handoff skill is installed', async ($, on) => {
  const seen: string[][] = []
  const clock = mock.clock(on)
  mock.store(on, { config: configured })
  listing(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage(360_000) }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    seen.push(e.questions[0].options.map(o => o.label))
    return answer(e, 'Continue')
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(seen).toEqual([['Compact', 'New session (/clear)', 'Continue']])
})

test('the Handoff option appears when the plugin skill is installed, and asks for the skill', async ($, on) => {
  const seen: string[][] = []
  let submitted = ''
  const clock = mock.clock(on)
  mock.store(on, { config: configured })
  listing(on, 'handoff:handoff')
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage(360_000) }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => {
    submitted = e.text
    return { drop: 'test' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    seen.push(e.questions[0].options.map(o => o.label))
    return answer(e, 'Handoff, then new session')
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(seen[0]).toContain('Handoff, then new session')
  expect(submitted).toContain('handoff skill')
})
