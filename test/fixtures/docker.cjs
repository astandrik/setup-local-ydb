#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.MOCK_DOCKER_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
const kind = args[0] === 'rm' ? 'container' : args[0];
const operation = args[0] === 'rm' ? 'rm' : args[1];
const name = args.at(-1);
const failure = state.unavailable || state.failures?.includes(`${kind}:${operation}`);
let output = '';
if (!failure) {
  if (operation === 'ls') {
    output = state[kind].join('\n');
  } else if (operation === 'rm' && !state.sticky?.includes(kind)) {
    state[kind] = state[kind].filter((item) => item !== name);
  }
}
fs.writeFileSync(file, JSON.stringify(state));
if (failure) {
  console.error(`fixture Docker failure: ${kind} ${operation}`);
  process.exitCode = 1;
} else {
  console.log(output);
}
