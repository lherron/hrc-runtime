const realStdoutWrite = process.stdout.write.bind(process.stdout)

process.stdout.write = ((
  chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | (() => void),
  callback?: () => void
) => {
  const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
  const resolvedCallback = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback

  if (typeof chunk === 'string') {
    realStdoutWrite(chunk, encoding ?? 'utf8')
  } else {
    realStdoutWrite(chunk)
  }
  resolvedCallback?.()
  return false
}) as typeof process.stdout.write

process.on('exit', () => {
  let callbackCalled = false
  const returned = process.stdout.write('µ', 'utf8', () => {
    callbackCalled = true
  })
  if (returned !== false) process.exitCode = 91
  if (!callbackCalled) process.exitCode = 92
})
