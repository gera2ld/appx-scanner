// @deno-types="https://unpkg.com/cac/mod.d.ts"
import { cac } from 'https://unpkg.com/cac/mod.js';
import { AppXScanner } from './scanner.ts';

const cli = cac('appx-scanner');

cli.command('<entry>')
.option('-H, --highlight <subtree>', 'Highlight subtree', {
  type: [String],
})
.action(async (entry: string, options: {
  highlight: string[],
}) => {
  const scanner = new AppXScanner(entry, {
    highlights: options.highlight,
  });
  await scanner.check();
});

cli.parse();
