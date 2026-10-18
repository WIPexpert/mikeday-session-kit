import type { EngineInterface, Register } from 'claude-code'

// Thresholds are percentages of the model's context window, the "used" figure of the
// Context panel. A percentage stays right when the window differs (1M, 200k, ...).
const DEFAULT_THRESHOLD_PCT = 35
const DEFAULT_STEP_PCT = 10
const MIN_PCT = 1
const MAX_PCT = 95

const COMPACT = 'Compact'
const HANDOFF = 'Handoff, then new session'
const FRESH = 'New session (/clear)'
const KEEP = 'Continue'

const VERSION = '0.6.5'

// Local counters, kept in this plugin's own store on this machine. Nothing is sent anywhere.
const STAT_NAMES = [
  'band.press',
  'shown',
  'pctSum',
  'choice.compact',
  'choice.handoff',
  'choice.fresh',
  'choice.keep',
  'choice.other',
  'choice.dismissed',
  'compact.session',
  'compact.command',
  'compact.failed',
  'handoff.sent',
  'handoff.failed',
  'fresh.failed',
  'firstRun',
] as const

const USAGE =
  'Usage: /context-guard <threshold> <step> | off | on | reset | ask | style <dialog|band|both> | stats | stats share | stats reset. Write each value as a percent of the window ("35%") or as thousands of tokens ("350k" or "350"), for example /context-guard 35% 10%.'

// What shows: the dialog when the threshold is passed, the band above the prompt, or both.
const STYLES = ['dialog', 'band', 'both'] as const
type Style = (typeof STYLES)[number]
const DEFAULT_STYLE: Style = 'both'

type Settings = {
  isEnabled: boolean
  isConfigured: boolean
  thresholdPct: number
  stepPct: number
  style: Style
}

const fmtK = (tokens: number) => `${Math.round(tokens / 1000)}k`
const round1 = (n: number) => Math.round(n * 10) / 10
const inRange = (pct: number) => pct >= MIN_PCT && pct <= MAX_PCT

// "35%" is a percent; "350k" or "350" is thousands of tokens, turned into a percent of the window.
const parseAmount = (text: string, windowTokens: number): number | undefined => {
  const percent = /(\d+(?:\.\d+)?)\s*%/.exec(text)
  const number = percent ?? /(\d+(?:\.\d+)?)/.exec(text)
  if (!number) return undefined
  const value = Number(number[1])
  const pct = round1(percent ? value : (value * 1000 * 100) / windowTokens)
  return Number.isFinite(pct) && inRange(pct) ? pct : undefined
}

const summarize = (settings: Settings, windowTokens: number, compactThreshold: number | undefined): string => {
  const at = Math.round((windowTokens * settings.thresholdPct) / 100)
  const step = Math.round((windowTokens * settings.stepPct) / 100)
  let text = `context-guard is ${settings.isEnabled ? 'on' : 'off'}: asks at ${settings.thresholdPct}% of the window (${fmtK(at)} of ${fmtK(windowTokens)} tokens), then every ${settings.stepPct}% (${fmtK(step)}) after "Continue".`
  text += ` Shows: ${settings.style === 'both' ? 'the dialog and the band above the prompt' : settings.style === 'band' ? 'the band above the prompt only' : 'the dialog only'}.`
  if (!settings.isConfigured) text += ' These are the defaults, not confirmed yet: it will ask on the next answer.'
  if (compactThreshold !== undefined && at >= compactThreshold) {
    text += ` Warning: Claude Code compacts on its own at about ${fmtK(compactThreshold)}, before this threshold.`
  }
  return text
}

// Each setting is its own key, so two sessions writing different settings do not overwrite each other.
// 0.2.x kept one `config` object; fold it in once, converting thousands of tokens to percents.
const migrateOldConfig = async ($: EngineInterface, windowTokens: number): Promise<void> => {
  const old = (await $.store.get('config')) as Record<string, unknown> | undefined
  if (old === undefined) return
  if ((await $.store.get('thresholdPct')) === undefined && typeof old === 'object' && old !== null) {
    const toPct = (k: unknown, fallback: number) => {
      const pct = typeof k === 'number' ? round1((k * 1000 * 100) / windowTokens) : NaN
      return inRange(pct) ? pct : fallback
    }
    await $.store.set('thresholdPct', toPct(old.thresholdK, DEFAULT_THRESHOLD_PCT))
    await $.store.set('stepPct', toPct(old.stepK, DEFAULT_STEP_PCT))
    await $.store.set('enabled', old.isEnabled !== false)
    await $.store.set('configured', old.isConfigured === true)
  }
  await $.store.delete('config')
}

const readSettings = async ($: EngineInterface, windowTokens: number): Promise<Settings> => {
  await migrateOldConfig($, windowTokens)
  const enabled = await $.store.get('enabled')
  const configured = await $.store.get('configured')
  const thresholdPct = await $.store.get('thresholdPct')
  const stepPct = await $.store.get('stepPct')
  const style = await $.store.get('style')
  return {
    isEnabled: enabled !== false,
    isConfigured: configured === true,
    thresholdPct: typeof thresholdPct === 'number' ? thresholdPct : DEFAULT_THRESHOLD_PCT,
    stepPct: typeof stepPct === 'number' ? stepPct : DEFAULT_STEP_PCT,
    style: STYLES.find(s => s === style) ?? DEFAULT_STYLE,
  }
}

// No surface means nobody can answer a dialog (a `claude -p` run, a background session).
// If the answer cannot be read, assume someone is there rather than stay silent.
const hasSurface = async ($: EngineInterface): Promise<boolean> => {
  try {
    return (await $.session.surfaces()).length > 0
  } catch {
    return true
  }
}

// The token count at which Claude Code compacts by itself, when it can be read.
const compactAt = async ($: EngineInterface): Promise<number | undefined> => {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    return context.breakdown?.autoCompactThreshold
  } catch {
    return undefined
  }
}

// Compaction goes through `$.session.compact()` where the session allows it. A headless session
// (the Claude desktop app runs on the SDK) refuses it: there compaction runs as a /compact prompt,
// so fall back to the command.
const compactNow = async ($: EngineInterface): Promise<'session' | 'command'> => {
  try {
    await $.session.compact()
    return 'session'
  } catch {
    await $.command.run({ command: 'compact' })
    return 'command'
  }
}

// A counter that cannot be written must never get in the user's way.
const bump = async ($: EngineInterface, name: string, by = 1): Promise<void> => {
  try {
    const key = `stat.${name}`
    const value = Number(await $.store.get(key))
    await $.store.set(key, (Number.isFinite(value) ? value : 0) + by)
    if ((await $.store.get('stat.since')) === undefined) {
      await $.store.set('stat.since', new Date(await $.clock.now()).toISOString().slice(0, 10))
    }
  } catch {
    // Statistics are optional.
  }
}

const readCounts = async ($: EngineInterface): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {}
  for (const name of STAT_NAMES) {
    const value = Number(await $.store.get(`stat.${name}`))
    counts[name] = Number.isFinite(value) ? value : 0
  }
  return counts
}

const statsText = async ($: EngineInterface): Promise<string> => {
  const since = await $.store.get('stat.since')
  if (typeof since !== 'string') {
    return 'context-guard has no statistics yet. They start counting on this machine when the dialog first appears.'
  }
  const n = await readCounts($)
  const c = (name: string) => n[name] ?? 0
  const avg = c('shown') > 0 ? Math.round(c('pctSum') / c('shown')) : 0
  return [
    `context-guard statistics since ${since} (this machine, all your sessions; nothing is sent anywhere):`,
    `dialogs shown: ${c('shown')}, on average at ${avg}% of the window`,
    `answers: Compact ${c('choice.compact')} · Handoff ${c('choice.handoff')} · New session ${c('choice.fresh')} · Continue ${c('choice.keep')} · typed text ${c('choice.other')} · dismissed ${c('choice.dismissed')}`,
    `compact: ${c('compact.session')} through the session, ${c('compact.command')} through /compact, ${c('compact.failed')} failed`,
    `handoff requests: ${c('handoff.sent')} sent, ${c('handoff.failed')} failed · /clear failed: ${c('fresh.failed')}`,
    `first-run questions answered: ${c('firstRun')}`,
    `band buttons pressed: ${c('band.press')}`,
  ].join('\n')
}

// Counts and settings only: no texts, paths, names or ids. The user decides whether to share it.
const statsShare = async ($: EngineInterface, settings: Settings, windowTokens: number): Promise<string> => {
  const since = await $.store.get('stat.since')
  const n = await readCounts($)
  const c = (name: string) => n[name] ?? 0
  return JSON.stringify(
    {
      tool: 'context-guard',
      version: VERSION,
      since: typeof since === 'string' ? since : null,
      windowTokens,
      thresholdPct: settings.thresholdPct,
      stepPct: settings.stepPct,
      dialogsShown: c('shown'),
      averagePctAtAsk: c('shown') > 0 ? Math.round(c('pctSum') / c('shown')) : null,
      answers: {
        compact: c('choice.compact'),
        handoff: c('choice.handoff'),
        newSession: c('choice.fresh'),
        continue: c('choice.keep'),
        typed: c('choice.other'),
        dismissed: c('choice.dismissed'),
      },
      compact: { viaSession: c('compact.session'), viaCommand: c('compact.command'), failed: c('compact.failed') },
      handoffRequests: { sent: c('handoff.sent'), failed: c('handoff.failed') },
      clearFailed: c('fresh.failed'),
      firstRunAnswered: c('firstRun'),
      bandPresses: c('band.press'),
      style: settings.style,
    },
    null,
    2,
  )
}

// The handoff option appears only when a handoff skill is installed. If the command list cannot be
// read, assume the skill is there rather than hide the option.
const dialogOptions = async ($: EngineInterface): Promise<string[]> => {
  const commands = await $.command.list().catch(() => undefined)
  const hasHandoff = commands === undefined || commands.some(c => c.name === 'handoff' || c.name.endsWith(':handoff'))
  return hasHandoff ? [COMPACT, HANDOFF, FRESH, KEEP] : [COMPACT, FRESH, KEEP]
}

// What the dialog and the band buttons report to: how to count, and what to say when an action fails.
type Report = {
  count: (name: string, by?: number) => Promise<void>
  failed: (action: string, err: unknown, manual?: string) => void
}

// The three actions are the same whether the dialog or a band button asks for them.
const doCompact = async ($: EngineInterface, r: Report): Promise<void> => {
  try {
    const route = await compactNow($)
    await r.count(route === 'session' ? 'compact.session' : 'compact.command')
  } catch (err) {
    await r.count('compact.failed')
    r.failed('compact', err, '/compact')
  }
}

const doHandoff = async ($: EngineInterface, r: Report): Promise<void> => {
  $.ui.toast('After the handoff is written, run /clear and paste the path into the new session.', { timeoutMs: 12000 })
  try {
    // prompt.submit refuses text starting with "/", so the skill is asked for in words.
    await $.prompt.submit({
      text: 'Invoke the handoff skill and write a handoff document for this conversation, so a fresh session can pick up the work. Then tell me the file path.',
    })
    await r.count('handoff.sent')
  } catch (err) {
    await r.count('handoff.failed')
    r.failed('handoff request', err)
  }
}

const doFresh = async ($: EngineInterface, r: Report): Promise<void> => {
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    await r.count('fresh.failed')
    r.failed('/clear', err, '/clear')
  }
}

// An action that fails must not fail silently: the user chose it.
const toastFailure = ($: EngineInterface, action: string, err: unknown, manual?: string): void => {
  const hint = manual ? ` Run ${manual} yourself.` : ''
  $.ui.toast(`context-guard: ${action} failed: ${String(err)}${hint}`, { timeoutMs: 12000 })
}

// The first-run questions: when to ask, and how much more context before asking again.
const runFirstRun = async ($: EngineInterface, windowTokens: number): Promise<void> => {
  let thresholdPct = DEFAULT_THRESHOLD_PCT
  let stepPct = DEFAULT_STEP_PCT
  try {
    const first = await $.ui.ask('context-guard: at what context size should I ask what to do? (share of the window)', {
      header: 'Threshold',
      options: [20, 35, 50].map(p => `${p}% (${fmtK((windowTokens * p) / 100)})`),
    })
    thresholdPct = parseAmount(first, windowTokens) ?? thresholdPct
    const second = await $.ui.ask('And how much more context before I ask again after "Continue"?', {
      header: 'Step',
      options: [5, 10, 20].map(p => `${p}% (${fmtK((windowTokens * p) / 100)})`),
    })
    stepPct = parseAmount(second, windowTokens) ?? stepPct
  } catch {
    // Dialog dismissed: keep the defaults and do not ask again.
  }
  await $.store.set('thresholdPct', thresholdPct)
  await $.store.set('stepPct', stepPct)
  await $.store.set('configured', true)
  await bump($, 'firstRun')
  $.ui.toast(`context-guard: asking at ${thresholdPct}% of the window, then every ${stepPct}%. Change it with /context-guard.`, {
    timeoutMs: 8000,
  })
}

type DialogParams = {
  tokens: number
  windowTokens: number
  percent: number | undefined
  options: string[]
  // A preview (`/context-guard ask`) is not counted in the statistics.
  isPreview: boolean
  // Called when the answer means "not now": the caller waits before asking again.
  snooze: () => void
}

// The dialog and what each answer does. The buttons really act, also in a preview.
const runDialog = async ($: EngineInterface, p: DialogParams): Promise<void> => {
  const report: Report = {
    count: async (name, by = 1) => {
      if (!p.isPreview) await bump($, name, by)
    },
    failed: (action, err, manual) => {
      toastFailure($, action, err, manual)
      p.snooze()
    },
  }
  try {
    const pct = p.percent ?? Math.round((p.tokens / p.windowTokens) * 100)
    await report.count('shown')
    await report.count('pctSum', pct)
    const answer = await $.ui.ask(`Context is ${pct}% of the window (${fmtK(p.tokens).toUpperCase()} tokens). What now?`, {
      header: 'Context',
      options: p.options,
    })
    const choice = answer === COMPACT ? 'compact' : answer === HANDOFF ? 'handoff' : answer === FRESH ? 'fresh' : answer === KEEP ? 'keep' : 'other'
    await report.count(`choice.${choice}`)
    if (answer === COMPACT) {
      await doCompact($, report)
    } else if (answer === HANDOFF) {
      await doHandoff($, report)
    } else if (answer === FRESH) {
      await doFresh($, report)
    } else {
      p.snooze()
    }
  } catch (err) {
    await report.count('choice.dismissed')
    $.ui.log(`context-guard: ${String(err)}`, { to: 'debug' })
    // Dialog dismissed: treat as Continue.
    p.snooze()
  }
}

// The band above the prompt and the spinner tail read what the last turn left: the context size,
// the settings and whether a handoff skill exists. The drawing never waits on the engine for them.
// `isKnown` is false right after a compact or a /clear, until the next answer gives a reading.
type Live = { tokens: number; windowTokens: number; percent: number; isKnown: boolean }
type Snapshot = { live: Live | undefined; settings: Settings | undefined; hasHandoff: boolean }
const EMPTY_SNAPSHOT: Snapshot = { live: undefined, settings: undefined, hasHandoff: true }

// When the numbers cannot be read at all, the band keeps what it had rather than disappear.
const takeSnapshot = async ($: EngineInterface, previous: Snapshot): Promise<Snapshot> => {
  try {
    const { context } = await $.session.usage()
    const tokens = context.tokens
    const live: Live =
      tokens === undefined
        ? { tokens: 0, windowTokens: context.window, percent: 0, isKnown: false }
        : { tokens, windowTokens: context.window, percent: context.percent ?? Math.round((tokens / context.window) * 100), isKnown: true }
    const settings = await readSettings($, context.window)
    const options = await dialogOptions($)
    return { live, settings, hasHandoff: options.includes(HANDOFF) }
  } catch {
    return previous
  }
}

// Colors: green below the ask line, amber past it, red from 90% of the window. The track is the
// same color, dark. The bar is drawn in cells, the last one a partial block, so it moves smoothly.
const ZONE = { calm: '#2fb67c', warn: '#e8a33a', hot: '#e5584f' } as const
const TRACK = { calm: '#1f3b2e', warn: '#46391d', hot: '#45231f' } as const
const HOT_PCT = 90
const PARTIAL = ['▏', '▎', '▍', '▌', '▋', '▊', '▉']
type Zone = keyof typeof ZONE

const zoneOf = (pct: number, thresholdPct: number): Zone => (pct < thresholdPct ? 'calm' : pct < HOT_PCT ? 'warn' : 'hot')

const fmtTokens = (tokens: number): string =>
  tokens >= 1_000_000 ? `${round1(tokens / 1_000_000)}M` : `${Math.round(tokens / 1000)}K`

type Cell = { text: string; fg: string; bg: string | undefined }

// One cell per step of the bar. The cell at the next ask line is a white bar, so the line is
// visible whether it lies ahead on the track or already behind the fill.
const barCells = (cells: number, pct: number, thresholdPct: number, nextPct: number): Cell[] => {
  const mark = Math.min(cells - 1, Math.max(0, Math.floor((nextPct / 100) * cells)))
  const out: Cell[] = []
  for (let i = 0; i < cells; i++) {
    const from = (i * 100) / cells
    const to = ((i + 1) * 100) / cells
    const zone = zoneOf(from + 0.01, thresholdPct)
    const filled = Math.max(0, Math.min(1, (pct - from) / (to - from)))
    if (i === mark) {
      out.push({ text: '│', fg: '#ffffff', bg: filled >= 1 ? ZONE[zone] : TRACK[zone] })
    } else if (filled >= 1) {
      out.push({ text: '█', fg: ZONE[zone], bg: undefined })
    } else if (filled <= 0) {
      out.push({ text: '█', fg: TRACK[zone], bg: undefined })
    } else {
      const part = Math.min(PARTIAL.length - 1, Math.max(0, Math.round(filled * 8) - 1))
      out.push({ text: PARTIAL[part] ?? '▏', fg: ZONE[zone], bg: TRACK[zone] })
    }
  }
  return out
}

// Neighbouring cells with the same colors become one piece of text.
const cellRuns = (cells: Cell[]): Cell[] => {
  const runs: Cell[] = []
  for (const cell of cells) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.fg === cell.fg && last.bg === cell.bg) last.text += cell.text
    else runs.push({ ...cell })
  }
  return runs
}

const SVG_WIDTH = 140
const SVG_HEIGHT = 10

// The Desktop app draws the same bar as a rounded SVG: a faint track in three zones, the same
// zones solid up to the fill, and a white tick at the next ask line.
const svgBar = (pct: number, thresholdPct: number, nextPct: number): string => {
  const at = (p: number) => round1((Math.min(100, Math.max(0, p)) / 100) * SVG_WIDTH)
  const hotFrom = Math.max(thresholdPct, HOT_PCT)
  const zones = (opacity: number) =>
    [
      `<rect x="0" width="${at(thresholdPct)}" height="${SVG_HEIGHT}" fill="${ZONE.calm}" opacity="${opacity}"/>`,
      `<rect x="${at(thresholdPct)}" width="${round1(at(hotFrom) - at(thresholdPct))}" height="${SVG_HEIGHT}" fill="${ZONE.warn}" opacity="${opacity}"/>`,
      `<rect x="${at(hotFrom)}" width="${round1(SVG_WIDTH - at(hotFrom))}" height="${SVG_HEIGHT}" fill="${ZONE.hot}" opacity="${opacity}"/>`,
    ].join('')
  const tick = Math.min(SVG_WIDTH - 1.5, Math.max(1.5, at(nextPct)))
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}">`,
    `<defs><clipPath id="track"><rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" rx="5"/></clipPath>`,
    `<clipPath id="fill"><rect width="${at(pct)}" height="${SVG_HEIGHT}"/></clipPath></defs>`,
    `<g clip-path="url(#track)">${zones(0.22)}<g clip-path="url(#fill)">${zones(1)}</g></g>`,
    `<rect x="${round1(tick - 1)}" y="0" width="2" height="${SVG_HEIGHT}" rx="1" fill="#ffffff" stroke="#000000" stroke-opacity="0.45" stroke-width="0.5"/>`,
    '</svg>',
  ].join('')
}

// One way to write the band's text, from the full line down to the shortest.
type Variant = { used: string; tokens: string; ask: string }

// The band is one line. The variants run from the full text to the shortest; the first one that
// leaves the bar at least 8 cells wins. In the Desktop app the bar has a fixed size and the buttons
// are native, so the width only picks the variant. Widths are in columns.
const planBand = (columns: number, surface: string, buttonsWidth: number, variants: Variant[]): { variant: Variant; barCells: number } => {
  const last = variants[variants.length - 1] as Variant
  if (surface !== 'terminal') {
    const pick = columns >= 100 ? 0 : columns >= 84 ? 1 : columns >= 64 ? 2 : 3
    return { variant: variants[Math.min(pick, variants.length - 1)] ?? last, barCells: 0 }
  }
  // Margin 2, the name 8, a gap of 2 before the buttons.
  const overhead = 2 + 8 + 2 + buttonsWidth
  for (const v of variants) {
    const bar = columns - overhead - v.used.length - v.tokens.length - v.ask.length
    if (bar >= 8) return { variant: v, barCells: Math.min(40, bar) }
  }
  return { variant: last, barCells: 8 }
}

export const register: Register = on => {
  let nextAskAt: number | undefined
  let isBusy = false
  let view: Snapshot = EMPTY_SNAPSHOT
  // The band button waiting for its confirmation. Every button asks first, in the band itself: one
  // slip of a click must not compact or clear a session. The engine's own question dialog always
  // adds a free-text "Other", so it is not used here.
  let pending: 'compact' | 'handoff' | 'clear' | undefined

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'context-guard',
        description: 'Show or set when the context-size prompt appears (percent of the window, or k tokens).',
        argumentHint: '[<threshold> <step> | off | on | reset | ask | style <dialog|band|both> | stats | stats share | stats reset]',
      })
    } catch (err) {
      // A taken name must not stop the session from starting.
      $.ui.log(`context-guard: could not register /context-guard: ${String(err)}`, { to: 'debug' })
    }
    try {
      // The band shows the numbers of the last turn, so keep them current between turns too
      // (a compact or a /clear changes them without a turn).
      $.clock.every(8000, async () => {
        view = await takeSnapshot($, view)
        $.ui.invalidate('ui.render')
      })
    } catch (err) {
      $.ui.log(`context-guard: no refresh timer: ${String(err)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'context-guard' }, async ($, e) => {
    const args = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    const { context } = await $.session.usage()
    const windowTokens = context.window
    const settings = await readSettings($, windowTokens)

    if (args === '') {
      return { text: `${summarize(settings, windowTokens, await compactAt($))}\n${USAGE}` }
    }
    if (args === 'off' || args === 'on') {
      await $.store.set('enabled', args === 'on')
      view = await takeSnapshot($, view)
      $.ui.invalidate('ui.render')
      return { text: `context-guard is ${args}.` }
    }
    if (args === 'style' || args.startsWith('style ')) {
      const style = STYLES.find(s => s === args.slice(6).trim())
      if (style === undefined) return { text: `Style is ${settings.style}. Use /context-guard style ${STYLES.join(' | ')}: "dialog" asks when the threshold is passed, "band" only shows the bar above the prompt, "both" does both.` }
      await $.store.set('style', style)
      view = await takeSnapshot($, view)
      $.ui.invalidate('ui.render')
      return { text: `context-guard now shows: ${style === 'both' ? 'the dialog and the band above the prompt' : style === 'band' ? 'the band above the prompt only' : 'the dialog only'}.` }
    }
    if (args === 'ask') {
      if (!(await hasSurface($))) return { text: 'Nobody can answer a dialog in this session.' }
      if (isBusy) return { text: 'A context-guard dialog is already on its way.' }
      const options = await dialogOptions($)
      const tokens = context.tokens ?? 0
      isBusy = true
      $.clock.after(300, async () => {
        try {
          await runDialog($, {
            tokens,
            windowTokens,
            percent: context.percent,
            options,
            isPreview: true,
            snooze: () => {},
          })
        } finally {
          isBusy = false
        }
      })
      return { text: 'The context-guard dialog opens now with the current numbers. The buttons really act. This opening is not counted in the statistics.' }
    }
    if (args === 'stats') return { text: await statsText($) }
    if (args === 'stats share') {
      const shared = await statsShare($, settings, windowTokens)
      return { text: `Counts only, no texts, paths or names. Paste it into a GitHub issue if you want to share it.\n${shared}` }
    }
    if (args === 'stats reset') {
      for (const name of STAT_NAMES) await $.store.delete(`stat.${name}`)
      await $.store.delete('stat.since')
      return { text: 'context-guard statistics cleared.' }
    }
    if (args === 'reset') {
      await $.store.set('configured', false)
      view = await takeSnapshot($, view)
      $.ui.invalidate('ui.render')
      return { text: 'context-guard will ask for its thresholds again after the next answer.' }
    }
    const parts = args.split(/\s+/)
    const thresholdPct = parts.length === 2 ? parseAmount(parts[0] ?? '', windowTokens) : undefined
    const stepPct = parts.length === 2 ? parseAmount(parts[1] ?? '', windowTokens) : undefined
    if (thresholdPct === undefined || stepPct === undefined) return { text: USAGE }

    await $.store.set('thresholdPct', thresholdPct)
    await $.store.set('stepPct', stepPct)
    await $.store.set('enabled', true)
    await $.store.set('configured', true)
    nextAskAt = undefined
    view = await takeSnapshot($, view)
    $.ui.invalidate('ui.render')
    const saved: Settings = { isEnabled: true, isConfigured: true, thresholdPct, stepPct, style: settings.style }
    return { text: summarize(saved, windowTokens, await compactAt($)) }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // The band follows every answer of the main conversation, whatever else happens below.
    if (e.agentId === undefined && e.reason === 'answer') {
      view = await takeSnapshot($, view)
      $.ui.invalidate('ui.render')
    }
    if (e.agentId !== undefined || e.reason !== 'answer' || isBusy) return done
    if (!(await hasSurface($))) return done

    const { context } = await $.session.usage()
    const windowTokens = context.window
    const settings = await readSettings($, windowTokens)
    if (!settings.isEnabled) return done

    // First run: ask for the threshold and the step once, after the turn is over.
    if (!settings.isConfigured) {
      isBusy = true
      $.clock.after(300, async () => {
        try {
          await runFirstRun($, windowTokens)
          view = await takeSnapshot($, view)
          $.ui.invalidate('ui.render')
        } finally {
          isBusy = false
        }
      })
      return done
    }

    // "band" only shows the bar: no dialog.
    if (settings.style === 'band') return done

    const tokens = context.tokens
    if (tokens === undefined) return done
    const thresholdTokens = (windowTokens * settings.thresholdPct) / 100
    const stepTokens = (windowTokens * settings.stepPct) / 100

    // Context shrank (compacted or cleared): re-arm at the base threshold.
    if (tokens < thresholdTokens) nextAskAt = undefined
    if (tokens < (nextAskAt ?? thresholdTokens)) return done

    const options = await dialogOptions($)

    isBusy = true
    // Defer so the turn is fully over before the dialog and any compact run.
    $.clock.after(300, async () => {
      try {
        await runDialog($, {
          tokens,
          windowTokens,
          percent: context.percent,
          options,
          isPreview: false,
          snooze: () => {
            nextAskAt = tokens + stepTokens
          },
        })
      } finally {
        isBusy = false
        // "Continue" moved the next ask line: show it.
        $.ui.invalidate('ui.render')
      }
    })

    return done
  })

  on('session.end', ($, e, next) => {
    nextAskAt = undefined
    pending = undefined
    // After /clear the context is empty again: show it once the new session has settled.
    $.clock.after(1500, async () => {
      view = await takeSnapshot($, view)
      $.ui.invalidate('ui.render')
    })
    return next(e)
  })

  // The band above the prompt: one line, what the context is and where the next ask lies.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    if (view.live === undefined) view = await takeSnapshot($, view)
    const { live, settings, hasHandoff } = view
    if (live === undefined || settings === undefined || settings.style === 'dialog') return next(e)

    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const report: Report = {
      count: async name => {
        await bump($, name)
      },
      failed: (action, err, manual) => toastFailure($, action, err, manual),
    }
    // Whatever a button starts, the numbers change soon after: take them again, twice.
    const refreshSoon = () => {
      for (const ms of [1500, 6000]) {
        $.clock.after(ms, async () => {
          view = await takeSnapshot($, view)
          $.ui.invalidate('ui.render')
        })
      }
    }
    const spacer = Box({ flexGrow: 1 })

    // The full name only where the user has not set it up yet, and the short name otherwise.
    if (!settings.isConfigured) {
      return Box({
        children: [
          Text({ children: ['context-guard is not set up: choose when it should ask  '], dimColor: true }),
          spacer,
          Button({
            key: 'setup',
            label: 'Set up',
            onPress: async () => {
              if (isBusy) return
              isBusy = true
              try {
                await runFirstRun($, live.windowTokens)
              } finally {
                isBusy = false
                view = await takeSnapshot($, view)
                $.ui.invalidate('ui.render')
              }
            },
          }),
        ],
      })
    }
    if (!settings.isEnabled) {
      return Box({
        children: [
          Text({ children: ['ctx-grd off  '], dimColor: true }),
          spacer,
          Button({
            key: 'turn-on',
            label: 'Turn on',
            onPress: async () => {
              await $.store.set('enabled', true)
              view = await takeSnapshot($, view)
              $.ui.invalidate('ui.render')
            },
          }),
        ],
      })
    }

    if (pending !== undefined) {
      const key = pending
      const question =
        key === 'compact' ? 'Compact now? The history is summarized.' : key === 'handoff' ? 'Write a handoff for this conversation?' : 'Run /clear? Drops this session\'s context.'
      const yes = key === 'compact' ? 'Yes, compact' : key === 'handoff' ? 'Yes, write it' : 'Yes, clear'
      return Box({
        alignItems: 'center',
        children: [
          Text({ children: ['ctx-grd '], dimColor: true }),
          Text({ color: ZONE.warn, wrap: 'truncate', children: [question] }),
          Text({ children: ['  '] }),
          spacer,
          Box({
            gap: 1,
            children: [
              Button({
                key: 'confirm',
                label: yes,
                onPress: async () => {
                  pending = undefined
                  $.ui.invalidate('ui.render')
                  await bump($, 'band.press')
                  if (key === 'compact') await doCompact($, report)
                  else if (key === 'handoff') await doHandoff($, report)
                  else await doFresh($, report)
                  refreshSoon()
                },
              }),
              Button({
                key: 'cancel',
                label: 'Cancel',
                autoFocus: true,
                onPress: () => {
                  pending = undefined
                  $.ui.invalidate('ui.render')
                },
              }),
            ],
          }),
        ],
      })
    }

    const thresholdTokens = (live.windowTokens * settings.thresholdPct) / 100
    // After "Continue" the next ask lies one step further; "band" alone never moves it.
    const nextPct =
      nextAskAt !== undefined && live.tokens >= thresholdTokens && settings.style === 'both'
        ? Math.min(99, round1(Math.max(settings.thresholdPct, (nextAskAt / live.windowTokens) * 100)))
        : settings.thresholdPct
    const isOver = live.isKnown && live.tokens >= (live.windowTokens * nextPct) / 100
    const zone = zoneOf(live.percent, settings.thresholdPct)
    // "264K of 1M" and the ask line in words, from the full text to the shortest.
    const usedText = live.isKnown ? ` ${live.percent}% used` : ' no reading yet'
    const tokensText = live.isKnown ? ` ${fmtTokens(live.tokens)} of ${fmtTokens(live.windowTokens)}` : ''
    const askLong = isOver ? ` | over ${nextPct}%` : ` | next ask at ${nextPct}%`
    const askShort = isOver ? ` | over ${nextPct}%` : ` | ask ${nextPct}%`
    const variants: Variant[] = [
      { used: usedText, tokens: tokensText, ask: askLong },
      { used: usedText, tokens: '', ask: askLong },
      { used: usedText, tokens: '', ask: askShort },
      { used: live.isKnown ? ` ${live.percent}%` : ' ?', tokens: '', ask: '' },
    ]
    const buttonsWidth = hasHandoff ? 33 : 21
    const plan = planBand(e.props.bodyColumns ?? 80, e.surface, buttonsWidth, variants)

    const bar = isTerminal
      ? Box({
          children: cellRuns(barCells(plan.barCells, live.percent, settings.thresholdPct, nextPct)).map(run =>
            run.bg === undefined ? Text({ color: run.fg, children: [run.text] }) : Text({ color: run.fg, backgroundColor: run.bg, children: [run.text] }),
          ),
        })
      : Svg({ source: svgBar(live.percent, settings.thresholdPct, nextPct), alt: `Context ${live.percent}% of the window, next ask at ${nextPct}%` })

    // Only Compact is bright once the line is passed: that is the one to press.
    const press = (key: 'compact' | 'handoff' | 'clear', label: string) =>
      Button({
        key,
        label,
        dimColor: !isOver || key !== 'compact',
        onPress: () => {
          pending = key
          $.ui.invalidate('ui.render')
          // Nobody answered: go back to the normal line.
          $.clock.after(20_000, () => {
            if (pending === key) {
              pending = undefined
              $.ui.invalidate('ui.render')
            }
          })
        },
      })

    return Box({
      alignItems: 'center',
      children: [
        Text({ children: ['ctx-grd '], dimColor: true }),
        bar,
        Text({ color: ZONE[zone], children: [plan.variant.used] }),
        ...(plan.variant.tokens === '' ? [] : [Text({ wrap: 'truncate', children: [plan.variant.tokens] })]),
        ...(plan.variant.ask === ''
          ? []
          : [isOver ? Text({ color: ZONE.warn, wrap: 'truncate', children: [plan.variant.ask] }) : Text({ dimColor: true, wrap: 'truncate', children: [plan.variant.ask] })]),
        Text({ children: ['  '] }),
        spacer,
        Box({
          gap: 1,
          children: [press('compact', 'Compact'), ...(hasHandoff ? [press('handoff', 'Handoff')] : []), press('clear', 'Clear')],
        }),
      ],
    })
  })

  // Beside the spinner's word while Claude works: `Thinking · ctx 77%…`.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const { live, settings } = view
    if (live === undefined || !live.isKnown || settings === undefined || !settings.isEnabled || !settings.isConfigured || settings.style === 'dialog') return next(e)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix ?? ''} · ctx ${live.percent}%` } })
  })
}
