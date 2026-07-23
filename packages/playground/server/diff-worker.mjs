import { diffProjects } from '@conf-ts/diff';

const MAX_INPUT_LENGTH = 2 * 1024 * 1024 + 1_024;
let input = '';

process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > MAX_INPUT_LENGTH) {
    throw new Error('Diff worker input exceeded its size limit.');
  }
}

const body = JSON.parse(input);
if (typeof body.left !== 'string' || typeof body.right !== 'string') {
  throw new Error('Diff worker expected left and right source strings.');
}

const filename = '/virtual/config.conf.ts';
const report = diffProjects(
  {
    filename,
    code: body.left,
    files: { [filename]: body.left },
  },
  {
    filename,
    code: body.right,
    files: { [filename]: body.right },
  },
  {
    macro: {
      mode: 'auto',
      env: {},
    },
    includeSource: true,
  },
);

process.stdout.write(JSON.stringify(report));
