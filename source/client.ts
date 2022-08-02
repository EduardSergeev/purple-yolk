import assert from 'assert'
import childProcess from 'child_process'
import readline from 'readline'
import vscode from 'vscode'

import my from '../package.json'

// https://hackage.haskell.org/package/hlint-3.4/docs/Language-Haskell-HLint.html#t:Idea
interface Idea {
  decl: string[],
  endColumn: number,
  endLine: number,
  file: string,
  from: string,
  hint: string,
  module: string[],
  note: string[],
  refactorings: string,
  severity: IdeaSeverity,
  startColumn: number,
  startLine: number,
  to: string | null,
}

// https://hackage.haskell.org/package/hlint-3.4/docs/Language-Haskell-HLint.html#t:Severity
enum IdeaSeverity {
  Ignore = 'Ignore',
  Suggestion = 'Suggestion',
  Warning = 'Warning',
  Error = 'Error',
}

interface Interpreter {
  key: Key | null,
  task: childProcess.ChildProcess,
}

type Key = string

interface Message {
  doc: string,
  reason: MessageReason | null,
  severity: MessageSeverity,
  span: MessageSpan | null,
}

// https://downloads.haskell.org/~ghc/9.2.4/docs/html/libraries/ghc-9.2.4/GHC-Driver-Flags.html#t:WarningFlag
type MessageReason = string

// https://downloads.haskell.org/~ghc/9.2.4/docs/html/libraries/ghc-9.2.4/GHC-Types-Error.html#t:Severity
enum MessageSeverity {
  SevDump = 'SevDump',
  SevError = 'SevError',
  SevFatal = 'SevFatal',
  SevInfo = 'SevInfo',
  SevInteractive = 'SevInteractive',
  SevOutput = 'SevOutput',
  SevWarning = 'SevWarning',
}

// https://downloads.haskell.org/~ghc/9.2.4/docs/html/libraries/ghc-9.2.4/GHC-Types-SrcLoc.html#t:SrcSpan
interface MessageSpan {
  endCol: number,
  endLine: number,
  file: string, // Can be `"<interactive>"`.
  startCol: number,
  startLine: number,
}

const DEFAULT_MESSAGE_SPAN: MessageSpan = {
  endCol: 1,
  endLine: 1,
  file: "<interactive>",
  startCol: 1,
  startLine: 1,
}

let INTERPRETER: Interpreter | null = null

const HASKELL_LANGUAGE_ID = 'haskell'

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel(my.displayName)
  const key = newKey()
  log(channel, key, `Activating ${my.name} version ${my.version} ...`)

  const interpreterCollection = vscode.languages.createDiagnosticCollection(my.name)
  const linterCollection = vscode.languages.createDiagnosticCollection(my.name)

  const status = vscode.languages.createLanguageStatusItem(my.name, HASKELL_LANGUAGE_ID)
  status.command = { command: `${my.name}.output.show`, title: 'Show Output' }
  status.text = 'Idle'
  status.name = my.displayName

  context.subscriptions.push(vscode.commands.registerCommand(
    `${my.name}.haskell.interpret`,
    () => commandHaskellInterpret(channel, status, interpreterCollection)))

  context.subscriptions.push(vscode.commands.registerCommand(
    `${my.name}.haskell.lint`,
    () => commandHaskellLint(channel, linterCollection)))

  context.subscriptions.push(vscode.commands.registerCommand(
    `${my.name}.output.show`,
    () => commandOutputShow(channel)))

  vscode.workspace.onDidSaveTextDocument((document) => {
    switch (document.languageId) {
      case HASKELL_LANGUAGE_ID:
        reloadInterpreter(channel, status)

        const shouldLint: boolean | undefined = vscode.workspace
          .getConfiguration(my.name)
          .get('haskell.linter.onSave')
        if (shouldLint) { commandHaskellLint(channel, linterCollection) }

        break
    }
  })

  vscode.languages.registerDocumentFormattingEditProvider(
    HASKELL_LANGUAGE_ID,
    {
      provideDocumentFormattingEdits: (document, _, token) =>
        formatHaskell(channel, document, token)
    })

  vscode.languages.registerDocumentRangeFormattingEditProvider(
    HASKELL_LANGUAGE_ID,
    {
      provideDocumentRangeFormattingEdits: (document, range, _, token) =>
        formatHaskellRange(channel, document, range, token)
    })

  commandHaskellInterpret(channel, status, interpreterCollection)

  log(channel, key, 'Successfully activated.')
}

function commandHaskellInterpret(
  channel: vscode.OutputChannel,
  status: vscode.LanguageStatusItem,
  collection: vscode.DiagnosticCollection
): void {
  const document = vscode.window.activeTextEditor?.document
  if (!document) { return }

  startInterpreter(channel, status, collection, document)
}

function commandHaskellLint(
  channel: vscode.OutputChannel,
  collection: vscode.DiagnosticCollection
): void {
  const document = vscode.window.activeTextEditor?.document
  if (!document) { return }

  vscode.window.withProgress(
    {
      cancellable: true,
      location: vscode.ProgressLocation.Window,
      title: `Linting`,
    },
    async (progress, token) => {
      progress.report({
        message: vscode.workspace.asRelativePath(document.uri)
      })
      const diagnostics = await lintHaskell(channel, document, token)
      collection.set(document.uri, diagnostics)
    })
}

function commandOutputShow(channel: vscode.OutputChannel): void {
  channel.show(true)
}

function formatHaskell(
  channel: vscode.OutputChannel,
  document: vscode.TextDocument,
  token: vscode.CancellationToken
): Promise<vscode.TextEdit[]> {
  const range: vscode.Range = document.validateRange(new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(Infinity, Infinity)))
  return formatHaskellRange(channel, document, range, token)
}

async function formatHaskellRange(
  channel: vscode.OutputChannel,
  document: vscode.TextDocument,
  range: vscode.Range,
  token: vscode.CancellationToken
): Promise<vscode.TextEdit[]> {
  const key = newKey()
  log(channel, key, `Formatting ${document.uri} ...`)

  const folder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!folder) {
    log(channel, key, 'Error: Missing workspace folder!')
    return []
  }

  const command: string | undefined = vscode.workspace
    .getConfiguration(my.name)
    .get('haskell.formatter.command')
  if (!command) {
    log(channel, key, 'Error: Missing formatter command!')
    return []
  }

  const cwd = folder.uri.path
  log(channel, key, `Running ${JSON.stringify(command)} in ${JSON.stringify(cwd)} ...`)
  const task: childProcess.ChildProcess = childProcess.spawn(command, {
    cwd,
    shell: true,
  })

  assert.ok(task.stderr)
  readline.createInterface(task.stderr).on('line', (line) => {
    log(channel, key, `[stderr] ${line}`)
  })

  let output = ''
  task.stdout?.on('data', (data) => output += data)

  token.onCancellationRequested(() => {
    log(channel, key, 'Cancelling ...')
    task.kill()
  })

  task.stdin?.end(document.getText(range))

  const code: number = await new Promise((resolve) => task.on('close', resolve))
  if (code !== 0) {
    log(channel, key, `Error: Formatter exited with ${code}!`)
    if (!task.killed) {
      const path = vscode.workspace.asRelativePath(document.uri)
      vscode.window.showErrorMessage(`Failed to format ${path}!`)
    }
    return []
  }

  log(channel, key, 'Successfully formatted.')
  return [new vscode.TextEdit(range, output)]
}

function ideaSeverityToDiagnostic(severity: IdeaSeverity): vscode.DiagnosticSeverity {
  switch (severity) {
    case IdeaSeverity.Ignore: return vscode.DiagnosticSeverity.Hint
    case IdeaSeverity.Suggestion: return vscode.DiagnosticSeverity.Information
    case IdeaSeverity.Warning: return vscode.DiagnosticSeverity.Warning
    case IdeaSeverity.Error: return vscode.DiagnosticSeverity.Error
  }
}

function ideaToDiagnostic(idea: Idea): vscode.Diagnostic {
  const range = ideaToRange(idea)
  const message = ideaToMessage(idea)
  const diagnosticSeverity = ideaSeverityToDiagnostic(idea.severity)
  const diagnostic = new vscode.Diagnostic(range, message, diagnosticSeverity)
  diagnostic.source = my.name
  return diagnostic
}

function ideaToMessage(idea: Idea): string {
  const lines: string[] = [idea.hint]
  if (idea.to) { lines.push(`Why not: ${idea.to}`) }
  for (const note of idea.note) { lines.push(`Note: ${note}`) }
  return lines.join('\n')
}

function ideaToRange(idea: Idea): vscode.Range {
  return new vscode.Range(
    new vscode.Position(idea.startLine - 1, idea.startColumn - 1),
    new vscode.Position(idea.endLine - 1, idea.endColumn - 1))
}

async function lintHaskell(
  channel: vscode.OutputChannel,
  document: vscode.TextDocument,
  token: vscode.CancellationToken
): Promise<vscode.Diagnostic[]> {
  const key = newKey()
  log(channel, key, `Linting ${document.uri} ...`)

  const folder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!folder) {
    log(channel, key, 'Error: Missing workspace folder!')
    return []
  }

  const command: string | undefined = vscode.workspace
    .getConfiguration(my.name)
    .get('haskell.linter.command')
  if (!command) {
    log(channel, key, 'Error: Missing linter command!')
    return []
  }

  const cwd = folder.uri.path
  log(channel, key, `Running ${JSON.stringify(command)} in ${JSON.stringify(cwd)} ...`)
  const task: childProcess.ChildProcess = childProcess.spawn(command, {
    cwd,
    shell: true,
  })

  assert.ok(task.stderr)
  readline.createInterface(task.stderr).on('line', (line) => {
    log(channel, key, `[stderr] ${line}`)
  })

  let output = ''
  task.stdout?.on('data', (data) => output += data)

  token.onCancellationRequested(() => {
    log(channel, key, 'Cancelling ...')
    task.kill()
  })

  task.stdin?.end(document.getText())

  const code: number = await new Promise((resolve) => task.on('close', resolve))
  const path = vscode.workspace.asRelativePath(document.uri)
  if (code !== 0) {
    log(channel, key, `Error: Linter exited with ${code}!`)
    if (!task.killed) {
      vscode.window.showErrorMessage(`Failed to lint ${path}!`)
    }
    return []
  }

  let ideas: Idea[]
  try {
    ideas = JSON.parse(output)
  } catch (error) {
    log(channel, key, `Error: ${error}`)
    vscode.window.showErrorMessage(`Failed to lint ${path}!`)
    return []
  }

  log(channel, key, 'Successfully linted.')
  return ideas.map(ideaToDiagnostic)
}

function log(
  channel: vscode.OutputChannel,
  key: Key,
  message: string
): void {
  channel.appendLine(`${new Date().toISOString()} [${key}] ${message}`)
}

function messageSeverityToDiagnostic(
  severity: MessageSeverity
): vscode.DiagnosticSeverity {
  switch (severity) {
    case MessageSeverity.SevError: return vscode.DiagnosticSeverity.Error
    case MessageSeverity.SevFatal: return vscode.DiagnosticSeverity.Error
    case MessageSeverity.SevWarning: return vscode.DiagnosticSeverity.Warning
    default: return vscode.DiagnosticSeverity.Information
  }
}

function messageSpanToRange(span: MessageSpan): vscode.Range {
  return new vscode.Range(
    new vscode.Position(span.startLine - 1, span.startCol - 1),
    new vscode.Position(span.endLine - 1, span.endCol - 1))
}

function messageToDiagnostic(message: Message): vscode.Diagnostic {
  const range = messageSpanToRange(message.span || DEFAULT_MESSAGE_SPAN)
  const severity = messageSeverityToDiagnostic(message.severity)
  const diagnostic = new vscode.Diagnostic(range, message.doc, severity)
  if (message.reason) { diagnostic.code = message.reason }
  diagnostic.source = my.name
  return diagnostic
}

function newKey(): Key {
  return Math.floor(Math.random() * (0xffff + 1)).toString(16).padStart(4, '0')
}

async function reloadInterpreter(
  channel: vscode.OutputChannel,
  status: vscode.LanguageStatusItem
): Promise<void> {
  const key = newKey()
  log(channel, key, 'Reloading interpreter ...')

  if (!INTERPRETER) {
    log(channel, key, 'Error: Missing interpreter!')
    return
  }

  if (INTERPRETER.key) {
    log(channel, key, `Waiting for [${INTERPRETER.key}] ...`)
    while (INTERPRETER.key !== null) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  INTERPRETER.key = key

  status.busy = true
  status.detail = undefined
  status.text = 'Loading'

  const input = ':reload'
  log(channel, key, `[stdin] ${input}`)
  INTERPRETER.task.stdin?.write(`${input}\n`)

  while (INTERPRETER.key !== null) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  log(channel, key, 'Successfully reloaded.')
}

async function startInterpreter(
  channel: vscode.OutputChannel,
  status: vscode.LanguageStatusItem,
  collection: vscode.DiagnosticCollection,
  document: vscode.TextDocument
): Promise<void> {
  const key = newKey()
  log(channel, key, 'Starting interpreter ...')

  const folder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!folder) {
    log(channel, key, 'Error: Missing workspace folder!')
    return
  }

  const command: string | undefined = vscode.workspace
    .getConfiguration(my.name)
    .get('haskell.interpreter.command')
  if (!command) {
    log(channel, key, 'Error: Missing interpreter command!')
    return
  }

  status.busy = true
  status.detail = undefined
  status.text = 'Starting'

  if (INTERPRETER) {
    log(channel, key, `Stopping interpreter ${INTERPRETER.task.pid} ...`)
    INTERPRETER.task.kill()
    INTERPRETER = null
  }

  const cwd = folder.uri.path
  log(channel, key, `Running ${JSON.stringify(command)} in ${JSON.stringify(cwd)} ...`)
  const task: childProcess.ChildProcess = childProcess.spawn(command, {
    cwd,
    shell: true,
  })
  INTERPRETER = { key, task }

  task.on('close', (code) => {
    log(channel, key, `Error: Interpreter exited with ${code}!`)
    status.busy = false
    status.detail = undefined
    status.severity = vscode.LanguageStatusSeverity.Error
    status.text = 'Exited'
  })

  assert.ok(task.stderr)
  readline.createInterface(task.stderr).on('line', (line) => {
    log(channel, key, `[stderr] ${line}`)
  })

  const prompt = `{- ${my.name} ${my.version} ${key} -}`
  const input = `:set prompt "${prompt}\\n"`
  log(channel, key, `[stdin] ${input}`)
  task.stdin?.write(`${input}\n`)

  await new Promise<void>((resolve) => {
    assert.ok(task.stdout)
    readline.createInterface(task.stdout).on('line', (line) => {
      let shouldLog: boolean = true

      if (line.includes(prompt)) {
        if (INTERPRETER) { INTERPRETER.key = null }
        resolve()
        status.busy = false
        status.detail = undefined
        status.text = 'Idle'
        shouldLog = false
      }

      let message: Message | null = null
      try {
        message = JSON.parse(line)
      }
      catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error
        }
      }

      const pattern = /^\[ *(\d+) of (\d+)\] Compiling ([^ ]+) +\( ([^,]+)/
      const match = message?.doc.match(pattern)
      if (match) {
        status.detail = `${match[1]} of ${match[2]}: ${match[3]}`;

        const uri = vscode.Uri.joinPath(folder.uri, match[4])
        collection.delete(uri)

        shouldLog = false
      }

      if (message?.span && message.span.file !== DEFAULT_MESSAGE_SPAN.file) {
        const uri = vscode.Uri.joinPath(folder.uri, message.span.file)
        const diagnostic = messageToDiagnostic(message)
        collection.set(uri, (collection.get(uri) || []).concat(diagnostic))

        shouldLog = false
      }

      if (shouldLog) {
        log(channel, INTERPRETER?.key || '0000', `[stdout] ${line}`)
      }
    })
  })

  log(channel, key, 'Successfully started.')
}
