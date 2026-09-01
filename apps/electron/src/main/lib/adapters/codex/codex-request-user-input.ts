export interface CodexRequestUserInputOption {
  label: string
  description: string
}

export interface CodexRequestUserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: CodexRequestUserInputOption[] | null
}

export interface CodexRequestUserInputParams {
  threadId: string
  turnId: string
  itemId: string
  questions: CodexRequestUserInputQuestion[]
  isBlocking: boolean
  autoResolutionMs: number | null
}

export interface CodexRequestUserInputResponse {
  answers: Record<string, { answers: string[] }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseQuestion(value: unknown): CodexRequestUserInputQuestion | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' ||
    typeof value.header !== 'string' ||
    typeof value.question !== 'string' ||
    typeof value.isOther !== 'boolean' ||
    typeof value.isSecret !== 'boolean'
  ) {
    return null
  }

  let options: CodexRequestUserInputOption[] | null = null
  if (Array.isArray(value.options)) {
    options = []
    for (const option of value.options) {
      if (
        !isRecord(option) ||
        typeof option.label !== 'string' ||
        typeof option.description !== 'string'
      ) {
        return null
      }
      options.push({
        label: option.label,
        description: option.description,
      })
    }
  } else if (value.options !== null) {
    return null
  }

  return {
    id: value.id,
    header: value.header,
    question: value.question,
    isOther: value.isOther,
    isSecret: value.isSecret,
    options,
  }
}

export function parseCodexRequestUserInputParams(
  value: unknown,
): CodexRequestUserInputParams | null {
  if (!isRecord(value) || !Array.isArray(value.questions)) return null
  if (
    typeof value.threadId !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.itemId !== 'string' ||
    typeof value.isBlocking !== 'boolean' ||
    (value.autoResolutionMs !== null &&
      typeof value.autoResolutionMs !== 'number')
  ) {
    return null
  }

  const questions: CodexRequestUserInputQuestion[] = []
  for (const question of value.questions) {
    const parsed = parseQuestion(question)
    if (!parsed) return null
    questions.push(parsed)
  }

  return {
    threadId: value.threadId,
    turnId: value.turnId,
    itemId: value.itemId,
    questions,
    isBlocking: value.isBlocking,
    autoResolutionMs: value.autoResolutionMs,
  }
}

/** 转成现有 AskUserQuestion 输入，保留 Codex question id 作为稳定答案 key。 */
export function buildCodexAskUserInput(
  params: CodexRequestUserInputParams,
): Record<string, unknown> {
  return {
    questions: params.questions.map((question) => ({
      answerKey: question.id,
      header: question.header,
      question: question.question,
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        description: option.description,
      })),
      multiSelect: false,
      allowOther: question.isOther || !question.options?.length,
      secret: question.isSecret,
    })),
  }
}

/** AskUser 的扁平答案转回 App Server 要求的 questionId -> { answers[] }。 */
export function buildCodexRequestUserInputResponse(
  params: CodexRequestUserInputParams,
  value: unknown,
): CodexRequestUserInputResponse {
  const source = isRecord(value) ? value : {}
  const answers: CodexRequestUserInputResponse['answers'] = {}
  for (const question of params.questions) {
    const answer = source[question.id]
    if (typeof answer === 'string' && answer.trim()) {
      answers[question.id] = { answers: [answer] }
    }
  }
  return { answers }
}
