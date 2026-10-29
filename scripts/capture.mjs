#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { applyCaptures, parseFile, resolveBlock } from './http-lib.mjs';

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@%+,;{}?&!*()\[\]<>|~-]+$/.test(value)) {
    return value.replace(/([{}!*()<>|?&])/g, '\\$1');
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function main() {
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: node scripts/capture.mjs requests/01-....http [...more]');
    process.exitCode = 1;
    return;
  }

  const workDir = mkdtempSync(join(tmpdir(), 'api-learn-capture-'));
  try {
    for (const file of files) {
      const { variables, blocks } = parseFile(await readFile(file, 'utf8'));
      console.log(`# ${basename(file)}\n`);
      for (const block of blocks) {
        const request = resolveBlock(block, variables);
        if (request.name) console.log(`## ${request.name}\n`);
        if (request.waitMs > 0) {
          console.log(`# wait ${request.waitMs} ms\n`);
          await new Promise((resolveWait) => setTimeout(resolveWait, request.waitMs));
        }

        const headerFile = join(workDir, 'headers.txt');
        const bodyFile = join(workDir, 'body.bin');
        rmSync(headerFile, { force: true });
        rmSync(bodyFile, { force: true });
        const args = ['-sS', '-D', headerFile, '-o', bodyFile, '--request', request.method, request.url];
        const displayArgs = ['-sS', '-i', '--request', request.method, request.url];
        for (const [key, value] of Object.entries(request.headers)) {
          args.push('-H', `${key}: ${value}`);
          displayArgs.push('-H', `${key}: ${value}`);
        }
        for (const form of request.forms) {
          args.push('-F', form);
          displayArgs.push('-F', form);
        }
        if (request.body) {
          args.push('--data-binary', request.body);
          displayArgs.push('--data-binary', request.body);
        }

        console.log(`$ ${['curl', ...displayArgs].map(shellQuote).join(' ')}`);
        const result = spawnSync('curl', args, { encoding: 'utf8' });
        if (result.status !== 0) {
          console.log(`! curl failed: ${result.stderr.trim()}\n`);
          continue;
        }

        const headers = readFileSync(headerFile, 'utf8').trimEnd();
        console.log(headers);
        const headerMap = new Map(
          headers
            .split(/\r?\n/)
            .filter((line) => line.includes(':'))
            .map((line) => {
              const index = line.indexOf(':');
              return [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
            }),
        );
        const bodyBuffer = existsSync(bodyFile) ? readFileSync(bodyFile) : Buffer.alloc(0);
        const contentType = /^content-type:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? '';
        const isText = /json|text|csv|html|javascript|xml/i.test(contentType);
        if (bodyBuffer.length === 0) {
          console.log('');
        } else if (isText) {
          const body = bodyBuffer.toString('utf8');
          console.log(`\n${body.trimEnd()}`);
          applyCaptures(request.captures, body, variables, (header) => headerMap.get(header.toLowerCase()));
        } else {
          console.log(`\n<binary body: ${bodyBuffer.length} bytes, ${contentType || 'unknown type'}>`);
        }
        console.log('');
      }
    }
  } finally {
    if (!process.argv.includes('--keep-temp')) rmSync(workDir, { recursive: true, force: true });
    else console.log(`temp files kept in ${resolve(workDir)}`);
  }
}

await main();
