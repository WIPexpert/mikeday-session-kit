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

const VERSION = '0.5.0'

// Local counters, kept in this plugin's own store on this machine. Nothing is sent anywhere.
const STAT_NAMES = [
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
  'Usage: /context-guard <threshold> <step> | off | on | reset | ask | stats | stats share | stats reset. Write each value as a percent of the window ("35%") or as thousands of tokens ("350k" or "350"), for example /context-guard 35% 10%.'

type Settings = {
  isEnabled: boolean
  isConfigured: boolean
  thresholdPct: number
  stepPct: number
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
  return {
    isEnabled: enabled !== false,
    isConfigured: configured === true,
    thresholdPct: typeof thresholdPct === 'number' ? thresholdPct : DEFAULT_THRESHOLD_PCT,
    stepPct: typeof stepPct === 'number' ? stepPct : DEFAULT_STEP_PCT,
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
  const count = async (name: string, by = 1): Promise<void> => {
    if (!p.isPreview) await bump($, name, by)
  }
  // An action that fails must not fail silently: the user chose it.
  const failed = (action: string, err: unknown, manual?: string) => {
    const hint = manual ? ` Run ${manual} yourself.` : ''
    $.ui.toast(`context-guard: ${action} failed: ${String(err)}${hint}`, { timeoutMs: 12000 })
    p.snooze()
  }
  try {
    const pct = p.percent ?? Math.round((p.tokens / p.windowTokens) * 100)
    await count('shown')
    await count('pctSum', pct)
    const answer = await $.ui.ask(`Context is ${pct}% of the window (${fmtK(p.tokens).toUpperCase()} tokens). What now?`, {
      header: 'Context',
      options: p.options,
    })
    const choice = answer === COMPACT ? 'compact' : answer === HANDOFF ? 'handoff' : answer === FRESH ? 'fresh' : answer === KEEP ? 'keep' : 'other'
    await count(`choice.${choice}`)
    if (answer === COMPACT) {
      try {
        const route = await compactNow($)
        await count(route === 'session' ? 'compact.session' : 'compact.command')
      } catch (err) {
        await count('compact.failed')
        failed('compact', err, '/compact')
      }
    } else if (answer === HANDOFF) {
      $.ui.toast('After the handoff is written, run /clear and paste the path into the new session.', { timeoutMs: 12000 })
      try {
        // prompt.submit refuses text starting with "/", so the skill is asked for in words.
        await $.prompt.submit({
          text: 'Invoke the handoff skill and write a handoff document for this conversation, so a fresh session can pick up the work. Then tell me the file path.',
        })
        await count('handoff.sent')
      } catch (err) {
        await count('handoff.failed')
        failed('handoff request', err)
      }
    } else if (answer === FRESH) {
      try {
        await $.command.run({ command: 'clear' })
      } catch (err) {
        await count('fresh.failed')
        failed('/clear', err, '/clear')
      }
    } else {
      p.snooze()
    }
  } catch (err) {
    await count('choice.dismissed')
    $.ui.log(`context-guard: ${String(err)}`, { to: 'debug' })
    // Dialog dismissed: treat as Continue.
    p.snooze()
  }
}

export const register: Register = on => {
  let nextAskAt: number | undefined
  let isBusy = false

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'context-guard',
        description: 'Show or set when the context-size prompt appears (percent of the window, or k tokens).',
        argumentHint: '[<threshold> <step> | off | on | reset | ask | stats | stats share | stats reset]',
      })
    } catch (err) {
      // A taken name must not stop the session from starting.
      $.ui.log(`context-guard: could not register /context-guard: ${String(err)}`, { to: 'debug' })
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
      return { text: `context-guard is ${args}.` }
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
    const saved: Settings = { isEnabled: true, isConfigured: true, thresholdPct, stepPct }
    return { text: summarize(saved, windowTokens, await compactAt($)) }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
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
        } finally {
          isBusy = false
        }
      })
      return done
    }

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
      }
    })

    return done
  })

  on('session.end', ($, e, next) => {
    nextAskAt = undefined
    return next(e)
  })
}
