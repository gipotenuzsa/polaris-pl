export interface SseEvent {
  event?: string;
  data: string;
}

/** Разбирает поток Server-Sent Events по спецификации (многострочные data, комментарии, CRLF). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SseEvent | undefined => {
    if (data.length === 0) {
      event = undefined;
      return undefined;
    }
    const out: SseEvent = { event, data: data.join('\n') };
    event = undefined;
    data = [];
    return out;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
        const sepLen = buffer.startsWith('\r\n', nl) ? 2 : 1;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + sepLen);
        if (line === '') {
          const ev = flush();
          if (ev) yield ev;
        } else if (line.startsWith(':')) {
          continue;
        } else {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let val = colon === -1 ? '' : line.slice(colon + 1);
          if (val.startsWith(' ')) val = val.slice(1);
          if (field === 'event') event = val;
          else if (field === 'data') data.push(val);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const colon = buffer.indexOf(':');
      if (buffer.startsWith('data') && colon !== -1) data.push(buffer.slice(colon + 1).replace(/^ /, ''));
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
