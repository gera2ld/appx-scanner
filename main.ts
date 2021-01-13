import { cac } from 'https://cdn.jsdelivr.net/npm/cac@6.7.1/mod.ts';
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
