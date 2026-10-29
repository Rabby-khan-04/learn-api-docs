#!/usr/bin/env node
// Small .http runner for everyday use. scripts/capture.mjs is the variant that
// produces paste-ready curl transcripts for the documentation.
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { applyCaptures, parseFile, resolveBlock } from './http-lib.mjs';

async function main() {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const files =
    args.length > 0
      ? args
      : (await readdir('requests'))
          .filter((name) => name.endsWith('.http'))
          .sort()
          .map((name) => join('requests', name));

  for (const file of files) {
    const { variables, blocks } = parseFile(await readFile(file, 'utf8'));
    console.log(`\n===== ${basename(file)} (${blocks.length} request${blocks.length === 1 ? '' : 's'}) =====`);
    for (const block of blocks) {
      const request = resolveBlock(block, variables);
      console.log(`\n### ${request.name || `${request.method} ${request.url}`}`);
      if (request.waitMs > 0) {
        await new Promise((resolveWait) => setTimeout(resolveWait, request.waitMs));
      }
      console.log(`> ${request.method} ${request.url}`);
      for (const [key, value] of Object.entries(request.headers)) console.log(`> ${key}: ${value}`);
      if (request.body) console.log(`>\n${request.body}`);

      let response;
      try {
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body || undefined,
        });
      } catch (error) {
        console.log(`! request failed: ${error instanceof Error ? error.message : error}`);
        continue;
      }

      console.log(`\n< HTTP ${response.status} ${response.statusText}`);
      response.headers.forEach((value, key) => {
        if (['connection', 'keep-alive', 'date', 'transfer-encoding'].includes(key)) return;
        console.log(`< ${key}: ${value}`);
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!/json|text|csv|html|javascript|xml/i.test(contentType)) {
        const bytes = (await response.arrayBuffer()).byteLength;
        console.log(`\n<binary body: ${bytes} bytes, ${contentType || 'unknown type'}>`);
        continue;
      }
      const text = await response.text();
      if (!text) continue;
      try {
        console.log(`\n${JSON.stringify(JSON.parse(text), null, 2)}`);
      } catch {
        console.log(`\n${text}`);
      }
      applyCaptures(request.captures, text, variables, (header) => response.headers.get(header) ?? undefined);
    }
  }
}

await main();
