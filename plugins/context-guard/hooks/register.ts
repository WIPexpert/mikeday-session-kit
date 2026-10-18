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

const USAGE =
  'Usage: /context-guard <threshold> <step> | off | on | reset. Write each value as a percent of the window ("35%") or as thousands of tokens ("350k" or "350"), for example /context-guard 35% 10%.'

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

export const register: Register = on => {
  let nextAskAt: number | undefined
  let isBusy = false

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'context-guard',
        description: 'Show or set when the context-size prompt appears (percent of the window, or k tokens).',
        argumentHint: '[<threshold> <step> | off | on | reset]',
      })
    } catch (err) {
      // A taken name must not stop the session from starting.
      $.ui.log(`context-guard: could not register /context-guard: ${String(err)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'context-guard' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
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

    // Offer the handoff option only when a handoff skill is installed.
    // If the listing cannot be read, assume the skill is there rather than hide the option.
    const commands = await $.command.list().catch(() => undefined)
    const hasHandoff = commands === undefined || commands.some(c => c.name === 'handoff' || c.name.endsWith(':handoff'))
    const options = hasHandoff ? [COMPACT, HANDOFF, FRESH, KEEP] : [COMPACT, FRESH, KEEP]

    isBusy = true
    // Defer so the turn is fully over before the dialog and any compact run.
    $.clock.after(300, async () => {
      // An action that fails must not fail silently: the user chose it.
      const failed = (action: string, err: unknown) => {
        $.ui.toast(`context-guard: ${action} failed: ${String(err)}`, { timeoutMs: 10000 })
        nextAskAt = tokens + stepTokens
      }
      try {
        const answer = await $.ui.ask(
          `Context is ${context.percent ?? Math.round((tokens / windowTokens) * 100)}% of the window (${fmtK(tokens).toUpperCase()} tokens). What now?`,
          { header: 'Context', options },
        )
        if (answer === COMPACT) {
          try {
            await $.session.compact()
          } catch (err) {
            failed('compact', err)
          }
        } else if (answer === HANDOFF) {
          $.ui.toast('After the handoff is written, run /clear and paste the path into the new session.', { timeoutMs: 12000 })
          try {
            // prompt.submit refuses text starting with "/", so the skill is asked for in words.
            await $.prompt.submit({
              text: 'Invoke the handoff skill and write a handoff document for this conversation, so a fresh session can pick up the work. Then tell me the file path.',
            })
          } catch (err) {
            failed('handoff request', err)
          }
        } else if (answer === FRESH) {
          try {
            await $.command.run({ command: 'clear' })
          } catch (err) {
            failed('/clear', err)
          }
        } else {
          nextAskAt = tokens + stepTokens
        }
      } catch (err) {
        $.ui.log(`context-guard: ${String(err)}`, { to: 'debug' })
        // Dialog dismissed: treat as Continue.
        nextAskAt = tokens + stepTokens
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
