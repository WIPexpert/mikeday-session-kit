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

// ---- /context-guard ask ----

test('/context-guard ask opens the dialog below the threshold, and the buttons really act', async ($, on) => {
  let question = ''
  let ran = 0
  const clock = world(on, 100_000)
  mock.store(on, settings)
  on('ui.toast', () => ({ value: undefined }))
  on('command.run', { command: 'compact' }, () => {
    ran++
    return { text: 'compacted' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    question = e.questions[0].question
    return answer(e, 'Compact')
  })
  const reply = (await $.command.run({ command: 'context-guard', args: 'ask' })).text as string
  expect(reply).toContain('opens now')
  await clock.advance(1000)
  expect(question).toBe('Context is 10% of the window (100K tokens). What now?')
  expect(ran).toBe(1)
})

test('a preview from /context-guard ask is not counted in the statistics', async ($, on) => {
  const clock = world(on, 100_000)
  mock.store(on, settings)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => answer(e, 'Continue'))
  await $.command.run({ command: 'context-guard', args: 'ask' })
  await clock.advance(1000)
  expect(await stats($)).toContain('no statistics yet')
})

test('/context-guard ask says so when nobody can answer', async ($, on) => {
  let asked = 0
  const clock = mock.clock(on)
  surfaces(on, [])
  listing(on)
  mock.store(on, settings)
  on('session.usage', () => ({ value: usage(100_000) }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    asked++
    return { deny: 'nobody there' }
  })
  const reply = (await $.command.run({ command: 'context-guard', args: 'ask' })).text as string
  await clock.advance(1000)
  expect(reply).toContain('Nobody can answer')
  expect(asked).toBe(0)
})

// What Claude Code passes to the band above the prompt, apart from the app and the width.
const band = (surface: 'terminal' | 'desktop', bodyColumns = 80) =>
  ({
    plugin: 'context-guard',
    component: 'AbovePrompt',
    requestId: 'band',
    surface,
    viewport: { columns: 120, rows: 30 },
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  }) as const

// What Claude Code would draw at a site when the mod draws nothing.
const native = (on: On) => on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))

test('the band reads: bar, "18% used 180K of 1M | next ask at 35%", buttons', async ($, on) => {
  world(on, 180_000)
  mock.store(on, settings)
  native(on)
  const ui = await $.ui.mount(band('terminal', 100))
  expect(await ui.find({ type: 'Text', text: 'ctx-grd ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 18% used' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' 180K of 1M' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' | next ask at 35%' })).toBeDefined()
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  expect(await ui.find({ key: 'new' })).toBeUndefined()
  // No handoff skill in this world: no Handoff button.
  expect(await ui.find({ key: 'handoff' })).toBeUndefined()
})

test('the band draws a bar of colored cells in the terminal and an SVG in the Desktop app', async ($, on) => {
  world(on, 180_000)
  mock.store(on, settings)
  native(on)
  const terminal = await $.ui.mount(band('terminal'))
  expect(await terminal.find({ type: 'Text', text: /^█+$/ })).toBeDefined()
  expect(await terminal.find({ type: 'Text', text: '│' })).toBeDefined()
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  const desktop = await $.ui.mount(band('desktop'))
  expect(await desktop.find({ type: 'Svg' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: /^█+$/ })).toBeUndefined()
})

test('the Handoff button appears when the handoff skill is installed', async ($, on) => {
  const clock = mock.clock(on)
  surfaces(on)
  listing(on, 'handoff:handoff')
  on('session.usage', () => ({ value: usage(180_000) }))
  mock.store(on, settings)
  native(on)
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ key: 'handoff' })).toBeDefined()
  await clock.settle()
})

test('past the ask line the band says so', async ($, on) => {
  world(on, 420_000)
  mock.store(on, settings)
  native(on)
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: ' | over 35%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' | next ask at 35%' })).toBeUndefined()
})

test('after "Continue" the band shows the next ask line one step further', async ($, on) => {
  const clock = world(on, 360_000)
  mock.store(on, settings)
  native(on)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => answer(e, 'Continue'))
  await $.turn.complete(complete)
  await clock.advance(1000)
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: ' | next ask at 46%' })).toBeDefined()
})

test('narrow widths drop the token counts, then shorten the words, then drop them', async ($, on) => {
  world(on, 180_000)
  mock.store(on, settings)
  native(on)
  const at = async (columns: number) => {
    const ui = await $.ui.mount(band('terminal', columns))
    const found = {
      tokens: (await ui.find({ type: 'Text', text: ' 180K of 1M' })) !== undefined,
      long: (await ui.find({ type: 'Text', text: ' | next ask at 35%' })) !== undefined,
      short: (await ui.find({ type: 'Text', text: ' | ask 35%' })) !== undefined,
      used: (await ui.find({ type: 'Text', text: ' 18% used' })) !== undefined,
      percent: (await ui.find({ type: 'Text', text: /^ 18%$/ })) !== undefined,
    }
    await ui.unmount()
    return found
  }
  expect(await at(120)).toEqual({ tokens: true, long: true, short: false, used: true, percent: false })
  expect(await at(70)).toEqual({ tokens: false, long: true, short: false, used: true, percent: false })
  expect(await at(60)).toEqual({ tokens: false, long: false, short: true, used: true, percent: false })
  expect(await at(52)).toEqual({ tokens: false, long: false, short: false, used: false, percent: true })
})

test('a band button asks in the band first, then acts, and the press is counted', async ($, on) => {
  let compacted = 0
  const clock = world(on, 420_000)
  mock.store(on, settings)
  native(on)
  on('session.compact', () => {
    compacted++
    return { skip: 'test' }
  })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'compact' })
  // Nothing happens yet: the band asks, with a button to confirm and one to cancel.
  expect(compacted).toBe(0)
  expect(await ui.find({ type: 'Text', text: /^Compact now\?/ })).toBeDefined()
  expect(await ui.find({ key: 'confirm' })).toBeDefined()
  const cancel = await ui.find({ key: 'cancel' })
  expect(cancel).toBeDefined()
  // The focus starts on Cancel, so a stray Enter takes the question back instead of acting.
  expect(JSON.stringify(cancel)).toContain('autoFocus')
  expect(await ui.find({ key: 'handoff' })).toBeUndefined()
  await ui.press({ key: 'confirm' })
  await clock.advance(10_000)
  expect(compacted).toBe(1)
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  const text = await stats($)
  expect(text).toContain('band buttons pressed: 1')
  expect(text).toContain('compact: 1 through the session')
})

test('a band button that fails says so', async ($, on) => {
  const toasts: string[] = []
  const clock = world(on, 420_000)
  mock.store(on, settings)
  native(on)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  // Nothing answers session.compact or the /compact command, so both reject.
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'confirm' })
  await clock.advance(10_000)
  expect(toasts.join('\n')).toContain('compact failed')
})

test('before the first-run questions the band uses the full name and offers Set up', async ($, on) => {
  const seen: string[] = []
  world(on, 50_000)
  mock.store(on)
  native(on)
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    seen.push(e.questions[0].header)
    return answer(e, e.questions[0].header === 'Threshold' ? '20% (200k)' : '5% (50k)')
  })
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /^context-guard is not set up/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ctx-grd ' })).toBeUndefined()
  await ui.press({ key: 'setup' })
  expect(seen).toEqual(['Threshold', 'Step'])
  expect(await status($)).not.toContain('not confirmed')
})

test('when off the band is one quiet line, and Turn on turns it on', async ($, on) => {
  world(on, 180_000)
  mock.store(on, { ...settings, enabled: false })
  native(on)
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: /^ctx-grd off/ })).toBeDefined()
  await ui.press({ key: 'turn-on' })
  expect(await status($)).toContain('is on')
})

test('style "dialog" leaves the band to Claude Code, "band" never opens the dialog', async ($, on) => {
  let asked = 0
  const clock = world(on, 420_000)
  mock.store(on, { ...settings, style: 'dialog' })
  native(on)
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked++
    return answer(e, 'Continue')
  })
  const dialogOnly = await $.ui.mount(band('terminal'))
  expect(await dialogOnly.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await dialogOnly.unmount()
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(1)

  const reply = (await $.command.run({ command: 'context-guard', args: 'style band' })).text as string
  expect(reply).toContain('band above the prompt only')
  await $.turn.complete(complete)
  await clock.advance(1000)
  expect(asked).toBe(1)
  const bandOnly = await $.ui.mount(band('terminal'))
  expect(await bandOnly.find({ type: 'Text', text: ' over 35%' })).toBeDefined()
})

test('/context-guard style shows the current style and rejects nonsense', async ($, on) => {
  world(on, 100_000)
  mock.store(on, settings)
  native(on)
  const run = async (args: string) => (await $.command.run({ command: 'context-guard', args })).text as string
  expect(await run('style')).toContain('Style is both')
  expect(await run('style nonsense')).toContain('Style is both')
  expect(await run('style dialog')).toContain('the dialog only')
  expect(await run('')).toContain('the dialog only')
})

test('the spinner gets a short tail with the percent, and nothing when the band is off', async ($, on) => {
  world(on, 770_000)
  mock.store(on, settings)
  // The stand-in for Claude Code's own spinner shows the suffix it was given.
  on('ui.render', (_$, e) => ({ type: 'Text', props: {}, children: [String((e.props as { suffix?: string }).suffix ?? '')] }))
  const spinner = {
    plugin: 'context-guard',
    component: 'Spinner',
    requestId: '',
    surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { word: 'Thinking', message: null, mode: 'thinking', suffix: ' · 3 tool calls' },
  } as const
  // The band takes the numbers when it first draws.
  await $.ui.mount(band('terminal'))
  const ui = await $.ui.mount(spinner)
  expect(await ui.find({ type: 'Text', text: ' · 3 tool calls · ctx 77%' })).toBeDefined()
})

test('Cancel, or no answer for 20 seconds, does nothing', async ($, on) => {
  let compacted = 0
  let cleared = 0
  const clock = world(on, 420_000)
  mock.store(on, settings)
  native(on)
  on('session.compact', () => {
    compacted++
    return { skip: 'test' }
  })
  on('command.run', { command: 'clear' }, () => {
    cleared++
    return { text: 'cleared' }
  })
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /^Run \/clear\?/ })).toBeDefined()
  await clock.advance(21_000)
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  expect(await ui.find({ key: 'confirm' })).toBeUndefined()
  expect(compacted).toBe(0)
  expect(cleared).toBe(0)
  expect(await stats($)).toContain('no statistics yet')
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'confirm' })
  expect(cleared).toBe(1)
})

test('after a compact the band stays and says there is no reading yet', async ($, on) => {
  const clock = mock.clock(on)
  surfaces(on)
  listing(on)
  mock.store(on, settings)
  native(on)
  // Right after a compact the engine has a window but no token count.
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  const ui = await $.ui.mount(band('terminal'))
  expect(await ui.find({ type: 'Text', text: ' no reading yet' })).toBeDefined()
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await clock.settle()
})
