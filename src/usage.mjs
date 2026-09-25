function normalizeUsage(usage) {
  return { inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? null, outputTokens: usage.output_tokens ?? usage.completion_tokens ?? null,
    cachedTokens: Number(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) || 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? null };
}

export function usageFromSse(text) {
  let result = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    try {
      const event = JSON.parse(line.slice(6));
      const usage = event.response?.usage ?? event.usage;
      if (!usage) continue;
      result = normalizeUsage(usage);
    } catch { /* non-JSON event */ }
  }
  return result;
}

export class SseObserver {
  constructor() { this.pending = ''; this.visible = ''; this.usage = null; this.decoder = new TextDecoder(); }
  push(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    if (this.pending.length > 1048576) this.pending = this.pending.slice(-1048576);
    while (true) {
      const lf = this.pending.indexOf('\n\n'), crlf = this.pending.indexOf('\r\n\r\n');
      const index = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
      if (index < 0) break;
      const length = index === crlf ? 4 : 2;
      const frame = this.pending.slice(0, index);
      this.pending = this.pending.slice(index + length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (!data) continue;
      try {
        const event = JSON.parse(data);
        const kind = event.type ?? /^event:\s*(.+)$/m.exec(frame)?.[1];
        if (kind === 'response.output_text.delta' && typeof event.delta === 'string' && this.visible.length < 200000) this.visible += event.delta.slice(0, 200000 - this.visible.length);
        const usage = event.response?.usage ?? event.usage;
        if (usage) this.usage = normalizeUsage(usage);
      } catch { /* non-JSON event */ }
    }
  }
  finish() {
    this.pending += this.decoder.decode();
    if (this.visible || !this.pending.trim().startsWith('{')) return;
    try {
      const body = JSON.parse(this.pending);
      this.usage = body.usage ? normalizeUsage(body.usage) : null;
      this.visible = (body.output ?? []).filter(x => x.role === 'assistant').flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text ?? '').join('\n').slice(0, 200000);
    } catch { /* not a single JSON response */ }
  }
}
