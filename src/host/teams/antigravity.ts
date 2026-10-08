import type * as acp from '@agentclientprotocol/sdk'

export const ANTIGRAVITY_DUPLICATE_MCP_TOOLS = new Set([
  'bash',
  'pwsh',
  'read',
  'read_image',
  'write',
  'edit',
  'str_replace_editor',
  'web_search',
  'web_fetch',
  'job_list',
  'job_output',
  'job_kill',
  'ask_user_question',
  'ask_question',
  'glob',
  'grep',
])

export function isAntigravityDuplicateTool(name: string): boolean {
  return ANTIGRAVITY_DUPLICATE_MCP_TOOLS.has(name) || name.startsWith('terminal_')
}

export function toPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export type AntigravityNativeToolName =
  | 'bash'
  | 'read'
  | 'edit'
  | 'ask_question'
  | 'web_fetch'
  | 'web_search'

export function resolveAntigravityNativeTool(
  call: Pick<acp.ToolCallUpdate, 'kind' | 'name' | 'title'> & { toolCallId?: string },
): AntigravityNativeToolName | undefined {
  // agy_acp_server.par omits call.name on session/request_permission and formats non-exec titles as "Run <tool>?"
  const titleName =
    typeof call.title === 'string'
      ? /^Run\s+([a-zA-Z0-9_]+)\?$/.exec(call.title)?.[1] ?? call.title
      : undefined
  const toolName = call.name ?? titleName

  if (
    toolName === 'ask_question' ||
    call.toolCallId?.startsWith('interaction_')
  ) {
    return 'ask_question'
  }
  if (
    toolName === 'run_command' ||
    toolName === 'bash' ||
    call.kind === 'execute'
  ) {
    return 'bash'
  }
  if (
    toolName === 'view_file' ||
    toolName === 'client_view_file' ||
    toolName === 'read' ||
    call.kind === 'read'
  ) {
    return 'read'
  }
  if (
    toolName === 'client_create_file' ||
    toolName === 'client_edit_file' ||
    toolName === 'write_to_file' ||
    toolName === 'replace_file_content' ||
    toolName === 'edit' ||
    call.kind === 'edit'
  ) {
    return 'edit'
  }
  if (
    toolName === 'read_url_content' ||
    toolName === 'web_fetch' ||
    call.kind === 'fetch'
  ) {
    return 'web_fetch'
  }
  if (
    toolName === 'search_web' ||
    toolName === 'web_search' ||
    call.kind === 'search'
  ) {
    return 'web_search'
  }
  return undefined
}

export interface DshQuestionItem {
  id: string
  question: string
  header?: string
  options?: { label: string }[]
  multi_select: boolean
}

export function parseAntigravityQuestions(args: unknown): DshQuestionItem[] {
  const input = toPlainRecord(args)
  if (input === undefined || !Array.isArray(input.questions)) return []
  return input.questions.map((raw, index) => {
    const q = toPlainRecord(raw)
    if (q === undefined) {
      return { id: `q${index + 1}`, question: '', multi_select: false }
    }
    const id = typeof q.id === 'string' && q.id.length > 0 ? q.id : `q${index + 1}`
    const question = typeof q.question === 'string' ? q.question : ''
    const header = typeof q.header === 'string' ? q.header : undefined
    let options: { label: string }[] | undefined
    if (Array.isArray(q.options)) {
      options = q.options.map((opt) => {
        if (typeof opt === 'string') return { label: opt }
        const optRec = toPlainRecord(opt)
        return { label: String(optRec?.label ?? opt) }
      })
    }
    const multi_select = Boolean(q.is_multi_select ?? q.IsMultiSelect ?? q.multi_select ?? q.multiSelect)
    return {
      id,
      question,
      ...(header !== undefined ? { header } : {}),
      ...(options !== undefined ? { options } : {}),
      multi_select,
    }
  })
}

function formatAnswers(answers: unknown): string | undefined {
  if (!Array.isArray(answers)) return undefined
  return answers
    .map((entry, index) => {
      const a = toPlainRecord(entry)
      const selected = Array.isArray(a?.selected) ? a.selected.map(String) : []
      const custom = typeof a?.custom === 'string' && a.custom.trim().length > 0 ? [a.custom.trim()] : []
      const chosen = [...selected, ...custom].join(', ')
      return `A${index + 1}: ${chosen}`
    })
    .join('\n')
}

export function formatAntigravityAskQuestionResult(result: unknown): string {
  if (result == null) return ''
  const directFormatted = formatAnswers(toPlainRecord(result)?.answers)
  if (directFormatted !== undefined) return directFormatted

  let text: string | undefined
  if (typeof result === 'string') {
    text = result
  } else if (typeof result === 'object') {
    const record = result as Record<string, unknown>
    if (Array.isArray(record.content)) {
      const textBlocks = record.content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string',
        )
        .map((block) => block.text)
      text = textBlocks[0] ?? (record.text as string | undefined)
    } else if (typeof record.text === 'string') {
      text = record.text
    }
  }

  if (text !== undefined) {
    try {
      const parsed = JSON.parse(text)
      const formatted = formatAnswers(toPlainRecord(parsed)?.answers)
      if (formatted !== undefined) return formatted
    } catch {
      return text
    }
    return text
  }
  return String(result)
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    const val = record[key]
    if (typeof val === 'string' && val.length > 0) return val
  }
  return undefined
}

function firstNumber(record: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (record === undefined) return undefined
  for (const key of keys) {
    const val = record[key]
    if (typeof val === 'number') return val
  }
  return undefined
}

export function normalizeAntigravityPresentation(
  rawInput: unknown,
  rawOutput: unknown,
  content: acp.ToolCallUpdate['content'],
  name: string,
  callTitle?: string | null,
): {
  rawInput: unknown
  rawOutput: unknown
  content: acp.ToolCallUpdate['content']
  title?: string
} {
  const input = toPlainRecord(rawInput)
  const output = toPlainRecord(rawOutput)
  let nextInput = rawInput
  let nextOutput = rawOutput
  let nextContent = content
  let title: string | undefined

  if (name === 'bash') {
    const command = firstString(input, ['command', 'CommandLine', 'command_line'])
    const cwd = firstString(input, ['cwd', 'Cwd', 'working_dir'])
    if (command !== undefined || cwd !== undefined) {
      nextInput = {
        ...(input ?? {}),
        ...(command !== undefined ? { command } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      }
    }
    if (command !== undefined && command.trim().length > 0) {
      title = command
    } else {
      const outCommand = firstString(output, ['commandLine', 'command'])
      if (outCommand !== undefined && outCommand.trim().length > 0) title = outCommand
    }
    const formatted_output = firstString(output, ['formatted_output', 'combinedOutput'])
    const exit_code = firstNumber(output, ['exit_code', 'exitCode'])
    if (formatted_output !== undefined || exit_code !== undefined) {
      nextOutput = {
        ...(output ?? {}),
        ...(formatted_output !== undefined ? { formatted_output } : {}),
        ...(exit_code !== undefined ? { exit_code, exitCode: exit_code } : {}),
      }
      if ((!Array.isArray(nextContent) || nextContent.length === 0) && formatted_output !== undefined) {
        nextContent = [{ type: 'content' as const, content: { type: 'text' as const, text: formatted_output } }]
      }
    }
  } else if (name === 'read') {
    const path = firstString(input, ['path', 'file_path', 'AbsolutePath', 'absolute_path'])
    if (path !== undefined) {
      nextInput = { ...(input ?? {}), path, file_path: path }
    }
  } else if (name === 'edit') {
    const path = firstString(input, ['path', 'file_path', 'TargetFile', 'target_file', 'FilePath'])
    if (path !== undefined) {
      nextInput = { ...(input ?? {}), path, file_path: path }
    }
  } else if (name === 'ask_question') {
    if (typeof callTitle === 'string' && callTitle.trim().length > 0 && callTitle.trim() !== 'ask_question') {
      title = callTitle.trim()
    } else if (input !== undefined) {
      const questions = parseAntigravityQuestions(input)
      const first = questions[0]
      if (first !== undefined && first.question.trim().length > 0) {
        title = first.question.trim()
      }
    }
    if (output !== undefined && (!Array.isArray(nextContent) || nextContent.length === 0)) {
      const formatted = formatAntigravityAskQuestionResult(output)
      if (formatted.length > 0) {
        nextContent = [{ type: 'content' as const, content: { type: 'text' as const, text: formatted } }]
      }
    }
  }

  if (
    typeof nextOutput === 'string' &&
    /^(Encountered retryable error from model provider|Agent execution terminated due to error)/i.test(nextOutput)
  ) {
    nextOutput = undefined
  }

  return {
    rawInput: nextInput,
    rawOutput: nextOutput,
    content: nextContent,
    ...(title !== undefined ? { title } : {}),
  }
}
