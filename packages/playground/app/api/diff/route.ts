import { spawn } from 'node:child_process';
import path from 'node:path';
import type { DiffReport } from '@conf-ts/diff';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MAX_SOURCE_LENGTH = 1024 * 1024;
const MAX_REPORT_LENGTH = 32 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 15_000;

function diffWorkerPath() {
  return path.join(process.cwd(), 'server', 'diff-worker.mjs');
}

function runNativeDiff(
  left: string,
  right: string,
  signal: AbortSignal,
): Promise<DiffReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [diffWorkerPath()], {
      env: { NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      child.kill();
      finish(() => reject(new Error('Diff request was cancelled.')));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('Diff request exceeded 15 seconds.')));
    }, WORKER_TIMEOUT_MS);

    signal.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > MAX_REPORT_LENGTH) {
        child.kill();
        finish(() => reject(new Error('Diff report exceeded 32 MiB.')));
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => {
      finish(() => {
        if (code !== 0) {
          reject(
            new Error(stderr.trim() || `Diff worker exited with ${code}.`),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout) as DiffReport);
        } catch {
          reject(new Error('Diff worker returned an invalid report.'));
        }
      });
    });
    child.stdin.end(JSON.stringify({ left, right }));
    if (signal.aborted) abort();
  });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      left?: unknown;
      right?: unknown;
    };
    if (typeof body.left !== 'string' || typeof body.right !== 'string') {
      return NextResponse.json(
        { error: 'left and right must be source strings' },
        { status: 400 },
      );
    }
    if (
      body.left.length > MAX_SOURCE_LENGTH ||
      body.right.length > MAX_SOURCE_LENGTH
    ) {
      return NextResponse.json(
        { error: 'Each source must be no larger than 1 MiB.' },
        { status: 413 },
      );
    }
    const report = await runNativeDiff(body.left, body.right, request.signal);
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 422 },
    );
  }
}
