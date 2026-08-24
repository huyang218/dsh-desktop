/**
 * The machinery a command table needs, shared by every table there is.
 *
 * A verb table — {@link ./browser-ops.js} is one, {@link ./miniapp-ops.js}
 * another — declares what its verbs are called, what they take and what to
 * say about them. What it should not have to declare is how a command line
 * turns into a call, or what shape an MCP client wants a tool list in. Those
 * are the same in both, and were the same in both twice before this file
 * existed.
 *
 * The table is the argument here, never a module-level import: this file
 * knows the grammar and nothing about the vocabulary.
 *
 * @typedef {object} Op
 * @property {string} summary what the model reads when choosing
 * @property {Record<string, object>} params JSON Schema properties
 * @property {string[]} [required]
 * @property {string[]} [positional] CLI argument order
 */

/**
 * The tool list an MCP client receives.
 *
 * @param {Record<string, Op>} table
 * @returns {Array<object>}
 */
export function toolSchemas(table) {
  return Object.entries(table).map(([name, op]) => ({
    name,
    description: op.summary,
    inputSchema: {
      type: 'object',
      properties: op.params,
      ...(op.required ? { required: op.required } : {}),
      additionalProperties: false,
    },
  }))
}

/**
 * Turns a command line into an op call.
 *
 * `dsh-browser type ref_3 "hello" --submit` — positional arguments in the
 * order the table declares, then `--flag` for the rest. A flag with no value
 * is `true`, which is what `--submit` and `--background` are for.
 *
 * @param {string[]} argv arguments after the verb
 * @param {Op} op
 * @returns {{ params: object } | { error: string }}
 */
export function parseArgs(argv, op) {
  const params = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]
    if (!argument.startsWith('--')) { positional.push(argument); continue }
    const [flag, inline] = splitFlag(argument.slice(2))
    if (!(flag in op.params)) return { error: `unknown option --${flag}` }
    if (inline !== undefined) { params[flag] = inline; continue }
    // A boolean flag takes no value; anything else takes the next argument,
    // and a value that looks like a flag means the user forgot one.
    if (op.params[flag].type === 'boolean') { params[flag] = true; continue }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) return { error: `--${flag} needs a value` }
    params[flag] = value
    i += 1
  }
  const slots = op.positional ?? []
  if (positional.length > slots.length) return { error: `too many arguments for this command` }
  positional.forEach((value, index) => { params[slots[index]] ??= value })
  for (const name of op.required ?? []) {
    if (params[name] === undefined) return { error: `missing ${name}` }
  }
  return { params: coerce(params, op) }
}

/** `--max=40` and `--max 40` mean the same thing. */
function splitFlag(text) {
  const equals = text.indexOf('=')
  return equals === -1 ? [text, undefined] : [text.slice(0, equals), text.slice(equals + 1)]
}

/**
 * A command line is all strings; the schema says which ones are not.
 *
 * Done here rather than in an engine so that the MCP path — where the model
 * sends real JSON types — reaches the engine with exactly the same shapes as
 * the command line does.
 */
function coerce(params, op) {
  const out = {}
  for (const [name, value] of Object.entries(params)) {
    const type = op.params[name]?.type
    if (type === 'integer' && typeof value === 'string') {
      const number = Number.parseInt(value, 10)
      out[name] = Number.isFinite(number) ? number : value
    } else if (type === 'boolean' && typeof value === 'string') {
      out[name] = value !== 'false' && value !== '0'
    } else {
      out[name] = value
    }
  }
  return out
}
