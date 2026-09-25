#!/usr/bin/env node
import { configFromEnv } from '../src/config.mjs';
import { requestPreflight } from '../src/hook-client.mjs';

const config = configFromEnv();
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const event = JSON.parse(input);
  if (event.hook_event_name !== 'UserPromptSubmit' || !event.prompt) process.exit(0);
  const response = await requestPreflight(event, config);
  if (response?.ok) {
    const body = await response.json();
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: body.guidance } }));
  }
} catch { /* hooks are advisory and fail open */ }
