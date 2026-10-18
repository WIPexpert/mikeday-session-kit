import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const complete = {
  reason: 'answer' as const,
  answer: 'ok',
  durationMs: 1,
  isAborted: false,
  turnId: 't1',
}

// What `$.session.usage()` returns beneath the mod. `compactAt` is the token count where
// Claude Code compacts by itself, read from the breakdown.
const usage = (tokens: number, windowTokens = 1_000_000, compactAt?: number) => ({
  startedAt: 0,
  context: {
    tokens,
    window: windowTokens,
    percent: Math.round((tokens / windowTokens) * 100),
    ...(compactAt === undefined ? {} : { breakdown: { autoCompactThreshold: compactAt } }),
  },
  rateLimits: [],
})

const settings = { enabled: true, configured: true, thresholdPct: 35, stepPct: 10 }

type Ask = { questions: { question: string; header: string; options: { label: string }[] }[] }
const answer = (e: Ask, label: string) => ({
  result: { questions: e.questions, answers: { [e.questions[0].question]: label } },
})

// What `$.command.list()` returns: with or without a handoff skill.
const listing = (on: On, name?: string) =>
  on('command.list', () => ({
    value: name ? [{ name, description: 'x', source: 'plugin' as const }] : [],
  }))

// Who can answer a dialog: `[]` is a headless run.
const surfaces = (on: On, value: readonly string[] = ['terminal']) =>
  on('session.surfaces', () => ({ value: value as never }))

// The usual world: a terminal, no handoff skill, the clock held, the turn answered.
const world = (on: On, tokens: number, windowTokens = 1_000_000) => {
  const clock = mock.clock(on)
  surfaces(on)
  listing(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage(tokens, windowTokens) }))
  return clock
}

const status = async ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  ((await $.command.run({ command: 'context-guard', args: '' })).text ?? '') as string

test('stays quiet below the threshold', async ($, on) => {
  let asked = 0
  const clock = world(on, 172_000)
  mock.store(on, settings)
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
  let question = ''
  const clock = world(on, 360_000)
  mock.store(on, settings)
  on('session.compact', () => {
    compacted++
    return { skip: 'test' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked++
    question = e.questions[0].question
    return answer(e, 'Compact')
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(1)
  expect(compacted).toBe(1)
  expect(question).toBe('Context is 36% of the window (360K tokens). What now?')
})

test('uses the stored percent, not the default', async ($, on) => {
  let asked = 0
  const clock = world(on, 250_000)
  mock.store(on, { ...settings, thresholdPct: 20 })
  on('session.compact', () => ({ skip: 'test' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked++
    return answer(e, 'Compact')
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(1)
})

test('the threshold follows the window: 35% of a 200k window is 70k', async ($, on) => {
  let asked = 0
  const clock = world(on, 80_000, 200_000)
  mock.store(on, settings)
  on('session.compact', () => ({ skip: 'test' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked++
    return answer(e, 'Compact')
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(1)
})

test('first run asks threshold and step once, with percents and tokens, then remembers them', async ($, on) => {
  const seen: { header: string; options: string[] }[] = []
  const clock = world(on, 10_000)
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0]
    seen.push({ header: q.header, options: q.options.map(o => o.label) })
    return answer(e, q.header === 'Threshold' ? '20% (200k)' : '5% (50k)')
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(seen.map(s => s.header)).toEqual(['Threshold', 'Step'])
  expect(seen[0].options).toEqual(['20% (200k)', '35% (350k)', '50% (500k)'])
  expect(seen[1].options).toEqual(['5% (50k)', '10% (100k)', '20% (200k)'])
  const shown = await status($)
  expect(shown).toContain('20%')
  expect(shown).toContain('5%')
  expect(shown).not.toContain('not confirmed')
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(seen.length).toBe(2)
})

test('first run builds its options from the window', async ($, on) => {
  let options: string[] = []
  const clock = world(on, 10_000, 200_000)
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    if (e.questions[0].header === 'Threshold') options = e.questions[0].options.map(o => o.label)
    return answer(e, e.questions[0].options[0].label)
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(options).toEqual(['20% (40k)', '35% (70k)', '50% (100k)'])
})

test('a dismissed first-run dialog keeps the defaults and is not asked again', async ($, on) => {
  let asked = 0
  const clock = world(on, 10_000)
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked++
    return { deny: 'dismissed' }
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  const shown = await status($)
  expect(shown).toContain('35%')
  expect(shown).toContain('10%')
  expect(shown).not.toContain('not confirmed')
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(1)
})

test('a headless session asks nothing and does not use up the first-run question', async ($, on) => {
  let asked = 0
  const clock = mock.clock(on)
  surfaces(on, [])
  listing(on)
  mock.store(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('session.usage', () => ({ value: usage(500_000) }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked++
    return { deny: 'nobody there' }
  })
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(0)
  expect(await status($)).toContain('not confirmed')
})

test('/context-guard sets by percent or by k tokens, shows, disables and resets', async ($, on) => {
  mock.store(on, settings)
  on('session.usage', () => ({ value: usage(0) }))
  const run = async (args: string) => (await $.command.run({ command: 'context-guard', args })).text as string

  expect(await run('')).toContain('350k')
  expect(await run('30% 5%')).toContain('30% of the window (300k of 1000k tokens), then every 5% (50k)')
  expect(await run('350k 100k')).toContain('35% of the window (350k of 1000k tokens), then every 10% (100k)')
  expect(await run('300 75')).toContain('30% of the window')
  expect(await run('nonsense')).toContain('Usage')
  expect(await run('0 10')).toContain('Usage')
  expect(await run('99% 10%')).toContain('Usage')
  expect(await run('35%')).toContain('Usage')
  expect(await run('off')).toContain('off')
  expect(await run('')).toContain('is off')
  expect(await run('on')).toContain('on')
  await run('reset')
  expect(await run('')).toContain('not confirmed')
})

test('/context-guard warns when Claude Code compacts before the threshold', async ($, on) => {
  mock.store(on, settings)
  on('session.usage', () => ({ value: usage(0, 1_000_000, 200_000) }))
  const text = (await $.command.run({ command: 'context-guard', args: '' })).text as string
  expect(text).toContain('Warning')
  expect(text).toContain('200k')
})

test('settings saved by 0.2.x are converted to percents', async ($, on) => {
  mock.store(on, { config: { isEnabled: true, isConfigured: true, thresholdK: 300, stepK: 75 } })
  on('session.usage', () => ({ value: usage(0) }))
  const text = (await $.command.run({ command: 'context-guard', args: '' })).text as string
  expect(text).toContain('30% of the window (300k')
  expect(text).toContain('every 7.5% (75k)')
  expect(text).not.toContain('not confirmed')
})

test('the Handoff option is left out when no handoff skill is installed', async ($, on) => {
  const seen: string[][] = []
  const clock = mock.clock(on)
  surfaces(on)
  listing(on)
  mock.store(on, settings)
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
  surfaces(on)
  listing(on, 'handoff:handoff')
  mock.store(on, settings)
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

test('a failed action is shown to the user, not hidden', async ($, on) => {
  const toasts: string[] = []
  const clock = world(on, 360_000)
  mock.store(on, settings)
  on('ui.toast', (_$, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  // Nothing answers session.compact or the /compact command, so both reject.
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => answer(e, 'Compact'))
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(toasts.join('\n')).toContain('compact failed')
  expect(toasts.join('\n')).toContain('Run /compact yourself')
})

test('Compact falls back to /compact where session.compact is refused (a headless or SDK session)', async ($, on) => {
  const toasts: string[] = []
  let ran = 0
  const clock = world(on, 360_000)
  mock.store(on, settings)
  on('ui.toast', (_$, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  // session.compact has no answer here, so it rejects, as in the desktop app.
  on('command.run', { command: 'compact' }, () => {
    ran++
    return { text: 'compacted' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => answer(e, 'Compact'))
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(ran).toBe(1)
  expect(toasts.join('\n')).not.toContain('failed')
})

// ---- local statistics ----

const stats = async ($: Parameters<Parameters<typeof test>[1]>[0], args = 'stats') =>
  ((await $.command.run({ command: 'context-guard', args })).text ?? '') as string

test('statistics are empty before the first dialog', async ($, on) => {
  world(on, 10_000)
  mock.store(on, settings)
  expect(await stats($)).toContain('no statistics yet')
})

test('statistics count the dialog and the answer, and say nothing is sent', async ($, on) => {
  const clock = world(on, 360_000)
  mock.store(on, settings)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => answer(e, 'Continue'))
  await $.turn.complete(complete)
  await clock.advance(1000)
  const text = await stats($)
  expect(text).toContain('dialogs shown: 1, on average at 36% of the window')
  expect(text).toContain('Continue 1')
  expect(text).toContain('Compact 0')
  expect(text).toContain('nothing is sent anywhere')
})

test('statistics count which way a compact went', async ($, on) => {
  const clock = world(on, 360_000)
  mock.store(on, settings)
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', { command: 'compact' }, () => ({ text: 'compacted' }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => answer(e, 'Compact'))
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(await stats($)).toContain('compact: 0 through the session, 1 through /compact, 0 failed')
})

test('statistics count a failed compact', async ($, on) => {
  const clock = world(on, 360_000)
  mock.store(on, settings)
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => answer(e, 'Compact'))
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(await stats($)).toContain('1 failed')
})

test('statistics count a dismissed dialog', async ($, on) => {
  const clock = world(on, 360_000)
  mock.store(on, settings)
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))
  await $.turn.complete(complete)
  await clock.advance(1000)
  const text = await stats($)
  expect(text).toContain('dialogs shown: 1')
  expect(text).toContain('dismissed 1')
})

test('stats share prints counts and settings only, as JSON', async ($, on) => {
  const clock = world(on, 360_000)
  mock.store(on, settings)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => answer(e, 'Continue'))
  await $.turn.complete(complete)
  await clock.advance(1000)
  const text = await stats($, 'stats share')
  expect(text).toContain('Counts only')
  const shared = JSON.parse(text.slice(text.indexOf('{')))
  expect(shared.dialogsShown).toBe(1)
  expect(shared.answers.continue).toBe(1)
  expect(shared.thresholdPct).toBe(35)
  expect(shared.stepPct).toBe(10)
  expect(shared.windowTokens).toBe(1_000_000)
  expect(text).not.toContain('/Users')
})

test('stats reset clears the counters', async ($, on) => {
  const clock = world(on, 360_000)
  mock.store(on, settings)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => answer(e, 'Continue'))
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(await stats($)).toContain('dialogs shown: 1')
  expect(await stats($, 'stats reset')).toContain('cleared')
  expect(await stats($)).toContain('no statistics yet')
})
