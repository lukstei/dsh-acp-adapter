import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import {
  createAcpNativePermissionHandler,
  type AcpPermissionAuditRecord,
} from '../../../src/domain/policy/permissions.ts'
import type { AcpNativeUserQuestionService } from '../../../src/domain/policy/elicitation.ts'

const params = (options: acp.PermissionOption[]): acp.RequestPermissionRequest => ({
  sessionId: 'acp-session',
  toolCall: {
    toolCallId: 'acp-call',
    title: 'Run command',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'echo hello' },
  },
  options,
})
const option = (optionId: string, name: string, kind: acp.PermissionOption['kind']): acp.PermissionOption => ({
  optionId,
  name,
  kind,
})
function bridge(
  answer: string | undefined,
  custom?: string,
): { handler: ReturnType<typeof createAcpNativePermissionHandler>; ask: ReturnType<typeof vi.fn> } {
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
    answers: [
      {
        id: questions[0]!.id,
        selected: answer === undefined ? [] : [answer],
        ...(custom === undefined ? {} : { custom }),
      },
    ],
  }))
  return {
    handler: createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({ id: 'live-agent' }) }),
    ask,
  }
}

describe('native ACP permission bridge', () => {
  it.each([undefined, 'en', 'zh', 'zh-CN'])(
    'leaves native approval chrome to the client for locale %s',
    async (locale) => {
      const approval = { request: vi.fn(async () => 'allowed-once' as const) }
      const handler = createAcpNativePermissionHandler({
        approval,
        ...(locale === undefined ? {} : { locale }),
        getAgent: () => ({}),
      })
      await handler(params([option('exact-id', 'Allow', 'allow_once')]))
      expect(approval.request).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'Run command\necho hello',
        }),
      )
    },
  )

  it('localizes question details and disambiguation while retaining Agent labels and option ids', async () => {
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Same · 选项 2'] }],
    }))
    const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, locale: 'zh', getAgent: () => ({}) })
    await expect(
      handler(params([option('a', 'Same', 'allow_always'), option('r', 'Same', 'reject_once')])),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'r' } })
    expect(ask.mock.calls[0]?.[0].questions[0]).toMatchObject({
      question: 'ACP Agent 请求执行命令的权限。\n工具: Run command',
      detail: '命令:\n\n```\necho hello\n```',
      options: [{ label: 'Same · 选项 1' }, { label: 'Same · 选项 2' }],
    })
  })

  it('makes missing command details explicit on the native approval card', async () => {
    const approval = { request: vi.fn(async () => 'rejected' as const) }
    const handler = createAcpNativePermissionHandler({ approval, getAgent: () => ({}) })
    await handler({
      ...params([option('a', 'Allow', 'allow_once')]),
      toolCall: { toolCallId: 'unknown', kind: 'execute' },
    })
    expect(approval.request).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('could not be matched to this request') }),
    )
  })

  it('uses the native approval card for allow-once/reject decisions and keeps the complete command', async () => {
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
    const command = `printf 'first'\nprintf '${'x'.repeat(400)}'`
    const handler = createAcpNativePermissionHandler({
      approval,
      userQuestions: { ask },
      getAgent: () => ({ id: 'live-agent' }),
    })
    await expect(
      handler({
        ...params([]),
        toolCall: { ...params([]).toolCall, rawInput: { command } },
        options: [
          option('once', 'Allow once', 'allow_once'),
          option('always', 'Always', 'allow_always'),
          option('reject', 'Reject', 'reject_once'),
        ],
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(approval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'acp-call',
        reason: expect.stringContaining(command),
      }),
    )
    expect(ask).not.toHaveBeenCalled()
  })

  it('extracts command details from Antigravity CommandLine property without unknownCommand copy', async () => {
    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const handler = createAcpNativePermissionHandler({
      approval,
      getAgent: () => ({ id: 'live-agent' }),
    })
    await handler({
      ...params([]),
      toolCall: {
        ...params([]).toolCall,
        kind: 'execute',
        title: 'git remote -v',
        rawInput: { CommandLine: 'git remote -v', Cwd: '/workspace' },
      },
      options: [option('allow', 'Allow', 'allow_once')],
    })
    expect(approval.request).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('git remote -v'),
      }),
    )
    const reason = (approval.request.mock.calls[0] as unknown as [{ reason: string }])[0].reason
    expect(reason).not.toContain('Command details were not provided')
  })

  it('extracts file path details from target_file and FilePath properties', async () => {
    for (const [key, path] of [
      ['target_file', '/workspace/src/foo.ts'],
      ['FilePath', '/workspace/src/bar.ts'],
    ] as const) {
      const { handler, ask } = bridge('Allow once')
      await handler({
        ...params([]),
        toolCall: {
          ...params([]).toolCall,
          kind: 'edit',
          title: 'edit_file',
          rawInput: { [key]: path },
        },
        options: [option('once', 'Allow once', 'allow_once'), option('reject', 'Reject', 'reject_once')],
      })
      expect(ask).toHaveBeenCalledWith(
        expect.objectContaining({
          questions: [
            expect.objectContaining({
              question: expect.stringContaining(`Target: ${path}`),
            }),
          ],
        }),
      )
    }
  })

  it('preserves exact Agent option ids and all four kinds through native questions', async () => {
    for (const [kind, id] of [
      ['allow_once', 'a1'],
      ['allow_always', 'a2'],
      ['reject_once', 'r1'],
      ['reject_always', 'r2'],
    ] as const) {
      const name =
        kind === 'allow_once'
          ? 'Allow once'
          : kind === 'allow_always'
            ? 'Always allow'
            : kind === 'reject_once'
              ? 'Reject once'
              : 'Always reject'
      const { handler, ask } = bridge(name)
      await expect(handler(params([option(id, name, kind)]))).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: id },
      })
      expect(ask).toHaveBeenCalledOnce()
    }
  })

  it('records asked and decided sidecar facts before returning', async () => {
    const records: AcpPermissionAuditRecord[] = []
    // Use a real question seam so this test also verifies the audit ordering.
    const question: AcpNativeUserQuestionService = {
      ask: async ({ questions }) => ({ answers: [{ id: questions[0]!.id, selected: ['Allow once'] }] }),
    }
    const real = createAcpNativePermissionHandler({
      userQuestions: question,
      getAgent: () => ({}),
      audit: {
        append: async (record) => {
          records.push(record)
        },
      },
      now: () => 100,
    })
    await expect(real(params([option('exact', 'Allow once', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'exact' },
    })
    expect(records.map((record) => record.data.phase)).toEqual(['asked', 'decided'])
    expect(records[1]?.data).toMatchObject({ decisionVia: 'native-question' })
  })

  it('fails closed for cancel/custom/unknown answers and unavailable service', async () => {
    await expect(bridge(undefined).handler(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    await expect(bridge('Allow [a]', 'typed').handler(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    await expect(bridge('Unknown [x]').handler(params([option('a', 'Allow', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    await expect(
      createAcpNativePermissionHandler({ getAgent: () => ({}) })(params([option('a', 'Allow', 'allow_once')])),
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('rejects oversized or duplicate identities before opening native UI', async () => {
    const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async () => ({ answers: [] }))
    const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}) })
    await expect(handler(params([option('', 'Allow', 'allow_once')]))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(ask).not.toHaveBeenCalled()
  })

  it('shows names by default, uses short ordinal disambiguation, and bounds long names', async () => {
    const longName = 'x'.repeat(500)
    const { handler, ask } = bridge('Same · option 2')
    await expect(
      handler(
        params([option('first-secret-id', 'Same', 'allow_once'), option('second-secret-id', 'Same', 'reject_always')]),
      ),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'second-secret-id' } })
    const question = ask.mock.calls[0]?.[0]
    expect(question?.questions[0]?.options).toEqual([{ label: 'Same · option 1' }, { label: 'Same · option 2' }])
    const long = bridge(`${'x'.repeat(119)}…`)
    await expect(long.handler(params([option('long-id', longName, 'allow_always')]))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'long-id' },
    })
    expect(long.ask.mock.calls[0]?.[0].questions[0]?.options?.[0]?.label.length).toBeLessThan(130)
  })

  it.each(['en', 'zh'] as const)(
    'keeps adversarial disambiguated labels unique and maps them exactly (%s)',
    async (locale) => {
      const suffix = locale === 'zh' ? '选项' : 'option'
      const options = [
        option('allow-first', 'Run', 'allow_once'),
        option('reject-second', 'Run', 'reject_once'),
        option('allow-always-third', `Run · ${suffix} 1`, 'allow_always'),
        option('reject-always-fourth', `Run · ${suffix} 2`, 'reject_always'),
        option('allow-fifth', `Run · ${suffix} 1 · ${suffix} 3`, 'allow_once'),
      ]
      let labels: string[] = []
      let selectedIndex = 0
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => {
        labels = questions[0]!.options!.map((entry) => entry.label)
        const index = selectedIndex++
        return { answers: [{ id: questions[0]!.id, selected: [labels[index]!] }] }
      })
      const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}), locale })
      for (const candidate of options) {
        await expect(handler(params(options))).resolves.toEqual({
          outcome: { outcome: 'selected', optionId: candidate.optionId },
        })
      }
      expect(new Set(labels).size).toBe(options.length)
      expect(labels).toEqual(
        locale === 'zh'
          ? ['1. Run · 选项 1', '2. Run · 选项 2', '3. Run · 选项 1', '4. Run · 选项 2', '5. Run · 选项 1 · 选项 3']
          : [
              '1. Run · option 1',
              '2. Run · option 2',
              '3. Run · option 1',
              '4. Run · option 2',
              '5. Run · option 1 · option 3',
            ],
      )
    },
  )

  it('cancels invalid, multiple, or custom answers even when labels collide before disambiguation', async () => {
    const options = [
      option('first', 'Run', 'allow_once'),
      option('second', 'Run', 'reject_once'),
      option('collision', 'Run · option 1', 'allow_always'),
    ]
    for (const selected of [['forged label'], ['Run · option 1', 'Run · option 2']]) {
      const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
        answers: [{ id: questions[0]!.id, selected }],
      }))
      const handler = createAcpNativePermissionHandler({ userQuestions: { ask }, getAgent: () => ({}) })
      await expect(handler(params(options))).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    }
    const custom = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
      answers: [{ id: questions[0]!.id, selected: ['Run · option 1'], custom: 'Allow' }],
    }))
    await expect(
      createAcpNativePermissionHandler({ userQuestions: { ask: custom }, getAgent: () => ({}) })(params(options)),
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('shows the complete command in the native multi-line detail without executing controls', async () => {
    const command = `printf '${'x'.repeat(600)}'\nprintf 'Authorization: Bearer visible-to-approver'\u001b[31m`
    const { handler, ask } = bridge('Allow once')
    await expect(
      handler({
        ...params([option('allow', 'Allow once', 'allow_once')]),
        toolCall: { ...params([]).toolCall, rawInput: { command } },
      }),
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })

    const question = ask.mock.calls[0]?.[0].questions[0]
    expect(question?.question).not.toContain(command)
    expect(question?.detail).toContain(command.slice(0, -5))
    expect(question?.detail).toContain('\\x1b[31m')
    expect(question?.detail).not.toContain('\u001b')
    expect(question?.detail).not.toContain('…')
  })
})

it.each([
  { rejectKind: 'reject_once' as const, expected: { outcome: 'selected', optionId: 'r' } },
  { rejectKind: 'reject_always' as const, expected: { outcome: 'cancelled' } },
])('never upgrades a native one-time rejection to $rejectKind', async ({ rejectKind, expected }) => {
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>()
  const records: AcpPermissionAuditRecord[] = []
  const handler = createAcpNativePermissionHandler({
    approval: { request: async () => 'rejected' },
    userQuestions: { ask },
    getAgent: () => ({}),
    audit: {
      append: async (record) => {
        records.push(record)
      },
    },
  })
  await expect(
    handler(params([option('a', 'Allow once', 'allow_once'), option('r', 'Reject', rejectKind)])),
  ).resolves.toEqual({ outcome: expected })
  expect(ask).not.toHaveBeenCalled()
  expect(records.at(-1)?.data).not.toMatchObject({ selectedOptionKind: 'reject_always' })
})

it('routes multi-choice questions with multiple allow_once options to native userQuestions even when approval is configured', async () => {
  const approval = { request: vi.fn(async () => 'allowed-once' as const) }
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
    answers: [{ id: questions[0]!.id, selected: ['Submit as a single combined pull request'] }],
  }))
  const handler = createAcpNativePermissionHandler({
    approval,
    userQuestions: { ask },
    getAgent: () => ({ id: 'live-agent' }),
  })
  const res = await handler({
    sessionId: 's1',
    toolCall: {
      toolCallId: 'interaction_aba27307',
      title: 'How should we package the upstream pull request(s)?',
      kind: 'other',
    },
    options: [
      option(
        '1',
        '(Recommended) Split into three separate PRs with dedicated branches and commit scopes',
        'allow_once',
      ),
      option('2', 'Submit as a single combined pull request', 'allow_once'),
    ],
  })
  expect(approval.request).not.toHaveBeenCalled()
  expect(ask).toHaveBeenCalledOnce()
  expect(ask.mock.calls[0]![0].questions[0]).toMatchObject({
    question: 'How should we package the upstream pull request(s)?',
    options: [
      { label: '(Recommended) Split into three separate PRs with dedicated branches and commit scopes' },
      { label: 'Submit as a single combined pull request' },
    ],
  })
  expect(res).toEqual({
    outcome: { outcome: 'selected', optionId: '2' },
  })
})

it('falls back to rawInput question or questionPrompt when toolCall title is uninformative', async () => {
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
    answers: [{ id: questions[0]!.id, selected: ['Option A'] }],
  }))
  const handler = createAcpNativePermissionHandler({
    userQuestions: { ask },
    getAgent: () => ({ id: 'live-agent' }),
  })

  // 1. Title is "ask_question", but rawInput has questions
  await handler({
    sessionId: 's1',
    toolCall: {
      toolCallId: 'interaction_1',
      title: 'ask_question',
      rawInput: { questions: [{ question: 'Which branch?', options: ['Option A', 'Option B'] }] },
      kind: 'other',
    },
    options: [option('1', 'Option A', 'allow_once'), option('2', 'Option B', 'allow_once')],
  })
  expect(ask).toHaveBeenLastCalledWith(
    expect.objectContaining({
      questions: [expect.objectContaining({ question: 'Which branch?' })],
    }),
  )

  // 2. Both title and rawInput questions are absent -> fallback to questionPrompt
  await handler({
    sessionId: 's1',
    toolCall: {
      toolCallId: 'interaction_2',
      title: 'ask_question',
      rawInput: {},
      kind: 'other',
    },
    options: [option('1', 'Option A', 'allow_once'), option('2', 'Option B', 'allow_once')],
  })
  expect(ask).toHaveBeenLastCalledWith(
    expect.objectContaining({
      questions: [expect.objectContaining({ question: 'Please select an option:' })],
    }),
  )

  // 3. Raw input question contains only whitespace -> fallback to questionPrompt
  await handler({
    sessionId: 's1',
    toolCall: {
      toolCallId: 'interaction_3',
      title: 'ask_question',
      rawInput: { questions: [{ question: '   ', options: ['Option A', 'Option B'] }] },
      kind: 'other',
    },
    options: [option('1', 'Option A', 'allow_once'), option('2', 'Option B', 'allow_once')],
  })
  expect(ask).toHaveBeenLastCalledWith(
    expect.objectContaining({
      questions: [expect.objectContaining({ question: 'Please select an option:' })],
    }),
  )
})

it('routes ask_question calls to interactive questions even with single allow_once', async () => {
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => ({
    answers: [{ id: questions[0]!.id, selected: ['Option A'] }],
  }))
  const approvalRequest = vi.fn()
  const handler = createAcpNativePermissionHandler({
    userQuestions: { ask },
    approval: { request: approvalRequest },
    getAgent: () => ({ id: 'live-agent' }),
  })

  await handler({
    sessionId: 's1',
    toolCall: {
      toolCallId: 'interaction_custom_id',
      name: 'ask_question',
      title: 'Which environment?',
      rawInput: { questions: [{ question: 'Which environment?', options: ['Staging'] }] },
      kind: 'other',
    },
    options: [option('1', 'Staging', 'allow_once')],
  })
  expect(approvalRequest).not.toHaveBeenCalled()
  expect(ask).toHaveBeenCalledWith(
    expect.objectContaining({
      questions: [expect.objectContaining({ question: 'Which environment?' })],
    }),
  )
})
