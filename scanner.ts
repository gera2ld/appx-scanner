import * as path from 'https://deno.land/std/path/mod.ts';
import { readFileStr } from 'https://deno.land/std/fs/mod.ts';
import { red, yellow } from 'https://deno.land/std/fmt/colors.ts';
import { parseXml, INode, IError } from './xml.ts';

const builtIns = [
  'block',
  'button',
  'canvas',
  'image',
  'import-sjs',
  'input',
  'picker',
  'radio',
  'scroll-view',
  'template',
  'text',
  'textarea',
  'view',
  'web-view',
];

export class AppXScanner {
  root: string;
  pages: string[];
  components: string[];
  errors: { [key: string]: IError[] };

  constructor(entry: string) {
    this.root = entry;
    this.pages = [];
    this.components = [];
    this.errors = {};
  }

  async check() {
    this.errors = {};
    await this.checkApp();
    await this.checkPages();
    let hasError = false;
    console.info();
    for (const [entry, list] of Object.entries(this.errors)) {
      hasError = true;
      console.info(`- ${red(entry)}`);
      for (const error of list) {
        const title = [
          error.line && yellow(`@${error.line}:${error.col}`),
          error.message,
        ].filter(Boolean).join(' ');
        if (title) console.info(`  ${title}`);
        const content = (error.content || '').split('\n').map(line => `  ${line}`).join('\n');
        if (content) console.info(`\n${content}\n`);
      }
    }
    if (!hasError) console.info('No error is found');
  }

  async checkApp() {
    const app = JSON.parse(await this.readFile('app.json'));
    this.pages = app.pages as string[];
  }

  async checkPages() {
    for (const page of this.pages) {
      await this.checkPage(page);
    }
  }

  addError(entry: string, error: IError | IError[]) {
    let list = this.errors[entry];
    if (!list) {
      list = [];
      this.errors[entry] = list;
    }
    if (Array.isArray(error)) list.push(...error);
    else list.push(error);
  }

  async checkPage(entry: string) {
    let hasError = false;
    try {
      await this.assertFile(`${entry}.json`);
      await this.assertFile(`${entry}.js`);
      await this.assertFile(`${entry}.axml`);
      await this.assertFile(`${entry}.acss`);
    } catch (e) {
      this.addError(entry, { message: e.message });
      hasError = true;
    }
    if (!hasError) {
      const definitions = await this.extractDefinitions(entry);
      const components = await this.extractComponents(entry);
      for (const component of components) {
        if (!builtIns.includes(component) && !definitions.components.includes(component)) {
          hasError = true;
          this.addError(entry, { message: `Undefined component: ${component}` });
        }
      }
    }
  }

  async stat(fullpath: string) {
    const stat = await Deno.stat(fullpath);
    return stat;
  }

  async assertFile(entry: string) {
    const stat = await this.stat(`${this.root}/${entry}`);
    if (!stat.isFile) throw new Error(`Expect file: ${entry}`)
  }

  async readFile(entry: string) {
    const content = await readFileStr(`${this.root}/${entry}`);
    return content;
  }

  async extractDefinitions(entry: string) {
    const def = JSON.parse(await this.readFile(`${entry}.json`));
    const components = Object.keys(def.usingComponents || {});
    for (const key of components) {
      let value = def.usingComponents[key];
      try {
        if (value.startsWith('/')) {
          await this.assertFile(value.slice(1) + '.json');
        } else if (value.startsWith('.')) {
          await this.assertFile(path.join(path.dirname(entry), value) + '.json');
        } else {
          await this.assertFile(`node_modules/${value}.json`);
        }
      } catch {
        this.addError(entry, { message: `Component not found: ${key}` });
      }
    }
    return { components };
  }

  async extractComponents(entry: string) {
    const content = await this.readFile(`${entry}.axml`);
    const [root, warnings] = parseXml(content);
    if (warnings.length) {
      this.addError(entry, warnings);
    }
    const components = new Set<string>();
    traverse(root, node => {
      if (node.type === 'element' && node.name) {
        components.add(node.name);
      }
    });
    return components;
  }
}

function traverse(node: INode, callback: (node: INode) => void): void {
  callback(node);
  node.children?.forEach(child => traverse(child, callback));
}
