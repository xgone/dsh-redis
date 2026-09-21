import net from 'node:net';
import tls from 'node:tls';
import { Buffer } from 'node:buffer';

const INCOMPLETE = Symbol('redis-resp-incomplete');
const RESP_ERROR = Symbol('redis-resp-error');

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Redis operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function lineAt(buffer, start) {
  const end = buffer.indexOf(13, start);
  if (end < 0 || buffer[end + 1] !== 10) return INCOMPLETE;
  return {
    text: buffer.subarray(start, end).toString('utf8'),
    next: end + 2,
  };
}

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return INCOMPLETE;
  const prefix = buffer[offset];
  const line = lineAt(buffer, offset + 1);
  if (line === INCOMPLETE) return INCOMPLETE;

  if (prefix === 43) return { value: line.text, next: line.next };
  if (prefix === 45) return { value: { [RESP_ERROR]: true, message: line.text }, next: line.next };
  if (prefix === 58) {
    const value = Number(line.text);
    if (!Number.isFinite(value)) throw new Error('Invalid Redis integer reply.');
    return { value, next: line.next };
  }
  if (prefix === 95) return { value: null, next: line.next };

  if (prefix === 36) {
    const length = Number(line.text);
    if (!Number.isInteger(length)) throw new Error('Invalid Redis bulk-string length.');
    if (length === -1) return { value: null, next: line.next };
    const end = line.next + length;
    if (end + 2 > buffer.length || buffer[end] !== 13 || buffer[end + 1] !== 10) return INCOMPLETE;
    return { value: buffer.subarray(line.next, end).toString('utf8'), next: end + 2 };
  }

  if (prefix === 42) {
    const count = Number(line.text);
    if (!Number.isInteger(count)) throw new Error('Invalid Redis array length.');
    if (count === -1) return { value: null, next: line.next };
    const values = [];
    let next = line.next;
    for (let index = 0; index < count; index += 1) {
      const item = parseResp(buffer, next);
      if (item === INCOMPLETE) return INCOMPLETE;
      values.push(item.value);
      next = item.next;
    }
    return { value: values, next };
  }

  throw new Error('Unsupported Redis RESP reply type: ' + String.fromCharCode(prefix));
}

function encodeCommand(args) {
  const parts = [Buffer.from('*' + args.length + '\r\n', 'utf8')];
  for (const raw of args) {
    const value = typeof raw === 'string' ? raw : String(raw);
    const bytes = Buffer.from(value, 'utf8');
    parts.push(Buffer.from('$' + bytes.length + '\r\n', 'utf8'), bytes, Buffer.from('\r\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

function openSocket(connection, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const socket = connection.tls
      ? tls.connect({
          host: connection.host,
          port: connection.port,
          servername: connection.tlsServername,
          rejectUnauthorized: connection.rejectUnauthorized,
        })
      : net.createConnection({ host: connection.host, port: connection.port });
    const readyEvent = connection.tls ? 'secureConnect' : 'connect';
    // Keep one error listener for the whole socket lifetime. Timeout/cancel cleanup
    // may remove the per-operation listener before destroy() emits close events.
    const socketErrorGuard = () => {};
    socket.on('error', socketErrorGuard);
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error('Redis connection timed out after ' + timeoutMs + 'ms.');
      error.name = 'TimeoutError';
      finishReject(error);
      socket.destroy();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener(readyEvent, finishResolve);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.setNoDelay?.(true);
      resolve(socket);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onError = (error) => finishReject(error);
    const onClose = () => finishReject(new Error('Redis connection closed before it became ready.'));
    const onAbort = () => {
      const error = abortError(signal);
      finishReject(error);
      socket.destroy();
    };

    socket.once(readyEvent, finishResolve);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readResponse(socket, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      const error = new Error('Redis command timed out after ' + timeoutMs + 'ms.');
      error.name = 'TimeoutError';
      finishReject(error);
      socket.destroy();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onData = (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = parseResp(buffer);
        if (parsed === INCOMPLETE) return;
        if (parsed.value && typeof parsed.value === 'object' && parsed.value[RESP_ERROR] === true) {
          const error = new Error('Redis command failed: ' + parsed.value.message);
          error.name = 'RedisCommandError';
          finishReject(error);
          return;
        }
        finishResolve(parsed.value);
      } catch (error) {
        finishReject(error);
      }
    };
    const onError = (error) => finishReject(error);
    const onClose = () => finishReject(new Error('Redis connection closed before the command reply arrived.'));
    const onAbort = () => {
      const error = abortError(signal);
      finishReject(error);
      socket.destroy();
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function executeRedisCommand(connection, args, signal) {
  if (!Array.isArray(args) || args.length === 0) throw new Error('Redis command must contain at least one argument.');
  if (signal?.aborted) throw abortError(signal);
  const socket = await openSocket(connection, signal, connection.operationTimeoutMs);
  const send = async (command) => {
    if (signal?.aborted) throw abortError(signal);
    socket.write(encodeCommand(command));
    return readResponse(socket, signal, connection.operationTimeoutMs);
  };
  try {
    if (connection.password !== '') {
      if (connection.username !== '') await send(['AUTH', connection.username, connection.password]);
      else await send(['AUTH', connection.password]);
    }
    if (connection.db !== 0) await send(['SELECT', String(connection.db)]);
    return await send(args);
  } finally {
    socket.destroy();
  }
}
