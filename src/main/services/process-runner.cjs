const { spawn } = require('node:child_process');
const readline = require('node:readline');

function runProcess(executable, args, options = {}) {
  const { cwd, env, signal, onLine = () => {} } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let tail = '';
    const consume = (stream, source) => {
      const reader = readline.createInterface({ input: stream });
      reader.on('line', (line) => {
        tail = `${tail}\n${line}`.slice(-12000);
        onLine(line, source);
      });
    };
    consume(child.stdout, 'stdout');
    consume(child.stderr, 'stderr');

    const abort = () => child.kill('SIGTERM');
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    child.once('error', (error) => {
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
      } else if (code === 0) {
        resolve({ code, signal: exitSignal, tail });
      } else {
        reject(new Error(`进程退出码 ${code ?? exitSignal}。${tail ? `\n${tail}` : ''}`));
      }
    });
  });
}

function spawnManaged(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const abort = () => child.kill('SIGTERM');
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
  }
  return child;
}

module.exports = { runProcess, spawnManaged };
