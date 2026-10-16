import type { EngineInterface, Register } from 'claude-code'

// Settings live in $.store (kept across sessions). Values are in thousands of tokens
// of the whole context window: the headline figure of the Context panel.
type Config = {
  isEnabled: boolean
  isConfigured: boolean
  thresholdK: number
  stepK: number
}

const DEFAULT_CONFIG: Config = { isEnabled: true, isConfigured: false, thresholdK: 350, stepK: 100 }

const COMPACT = 'Compact'
const HANDOFF = 'Handoff, then new session'
const FRESH = 'New session (/clear)'
const KEEP = 'Continue'

const USAGE = 'Usage: /context-guard <threshold_k> <step_k> | off | on | reset'

const fmt = (tokens: number) => `${Math.round(tokens / 1000)}k`

// "350", "350k" or "about 350k tokens" -> 350; anything else -> undefined.
const parseK = (text: string): number | undefined => {
  const match = /(\d+(?:\.\d+)?)/.exec(text)
  const value = match ? Number(match[1]) : NaN
  return Number.isFinite(value) && value > 0 ? value : undefined
}

const readConfig = async ($: EngineInterface): Promise<Config> => {
  const raw = (await $.store.get('config')) as Partial<Config> | undefined
  return {
    isEnabled: raw?.isEnabled ?? DEFAULT_CONFIG.isEnabled,
    isConfigured: raw?.isConfigured ?? DEFAULT_CONFIG.isConfigured,
    thresholdK: parseK(String(raw?.thresholdK ?? '')) ?? DEFAULT_CONFIG.thresholdK,
    stepK: parseK(String(raw?.stepK ?? '')) ?? DEFAULT_CONFIG.stepK,
  }
}

export const register: Register = on => {
  let nextAskAt: number | undefined
  let isBusy = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-guard',
      description: 'Show or set when the context-size prompt appears (thresholds in k tokens).',
      argumentHint: '[<threshold_k> <step_k> | off | on | reset]',
    })
    return next(e)
  })

  on('command.run', { command: 'context-guard' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    const config = await readConfig($)
    const save = (patch: Partial<Config>) => $.store.set('config', { ...config, ...patch })

    if (args === '') {
      return {
        text: `context-guard is ${config.isEnabled ? 'on' : 'off'}: asks at ${config.thresholdK}k tokens, then every ${config.stepK}k after "Continue".${config.isConfigured ? '' : ' (defaults, not confirmed yet: it will ask on the next turn)'}\n${USAGE}`,
      }
    }
    if (args === 'off' || args === 'on') {
      await save({ isEnabled: args === 'on' })
      return { text: `context-guard is ${args}.` }
    }
    if (args === 'reset') {
      await save({ isConfigured: false })
      return { text: 'context-guard will ask for its thresholds again after the next answer.' }
    }
    const [thresholdText, stepText, ...rest] = args.split(/\s+/)
    const thresholdK = parseK(thresholdText ?? '')
    const stepK = parseK(stepText ?? '')
    if (thresholdK === undefined || stepK === undefined || rest.length > 0) return { text: USAGE }
    await save({ thresholdK, stepK, isConfigured: true, isEnabled: true })
    nextAskAt = undefined
    return { text: `context-guard will ask at ${thresholdK}k tokens, then every ${stepK}k after "Continue".` }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || isBusy) return done

    const config = await readConfig($)
    if (!config.isEnabled) return done

    // First run: ask for the thresholds once, after the turn is over.
    if (!config.isConfigured) {
      isBusy = true
      $.clock.after(300, async () => {
        try {
          let thresholdK = DEFAULT_CONFIG.thresholdK
          let stepK = DEFAULT_CONFIG.stepK
          try {
            const first = await $.ui.ask('context-guard: at what context size (tokens) should I ask what to do?', {
              header: 'Threshold',
              options: ['200k', '350k', '500k'],
            })
            thresholdK = parseK(first) ?? thresholdK
            const second = await $.ui.ask('And how much more context before I ask again after "Continue"?', {
              header: 'Step',
              options: ['50k', '100k', '200k'],
            })
            stepK = parseK(second) ?? stepK
          } catch {
            // Dialog dismissed: keep the defaults, do not ask again.
          }
          await $.store.set('config', { ...config, thresholdK, stepK, isConfigured: true })
          $.ui.toast(`context-guard: asking at ${thresholdK}k tokens, then every ${stepK}k. Change with /context-guard.`)
        } finally {
          isBusy = false
        }
      })
      return done
    }

    const { context } = await $.session.usage()
    const tokens = context.tokens
    if (tokens === undefined) return done

    // Context shrank (compacted or cleared): re-arm at the base threshold.
    if (tokens < config.thresholdK * 1000) nextAskAt = undefined
    if (tokens < (nextAskAt ?? config.thresholdK * 1000)) return done

    // Offer the handoff option only when a handoff skill is installed.
    // If the listing cannot be read, assume the skill is there rather than hide the option.
    const commands = await $.command.list().catch(() => undefined)
    const hasHandoff = commands === undefined || commands.some(c => c.name === 'handoff' || c.name.endsWith(':handoff'))
    const options = hasHandoff ? [COMPACT, HANDOFF, FRESH, KEEP] : [COMPACT, FRESH, KEEP]

    isBusy = true
    // Defer so the turn is fully over before the dialog and any compact run.
    $.clock.after(300, async () => {
      try {
        const answer = await $.ui.ask(
          `Context is ${fmt(tokens)} tokens (${context.percent ?? '?'}% of the window). What now?`,
          { header: 'Context', options },
        )
        if (answer === COMPACT) {
          await $.session.compact()
        } else if (answer === HANDOFF) {
          // The handoff skill writes the document in its own turn; /clear is the person's next step.
          $.ui.toast('After the handoff is written, run /clear and paste it into the new session.')
          // prompt.submit refuses text starting with "/", so the skill is asked for in words.
          await $.prompt.submit({
            text: 'Invoke the handoff skill and write a handoff document for this conversation, so a fresh session can pick up the work. Then tell me the file path.',
          })
        } else if (answer === FRESH) {
          await $.command.run({ command: 'clear' })
        } else {
          nextAskAt = tokens + config.stepK * 1000
        }
      } catch (err) {
        $.ui.log(`context-guard: ${String(err)}`, { to: 'debug' })
        // Dialog dismissed or an action failed: treat as Continue.
        nextAskAt = tokens + config.stepK * 1000
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
