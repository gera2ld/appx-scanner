import { walk, ensureDir } from 'https://deno.land/std/fs/mod.ts';
import * as path from 'https://deno.land/std/path/mod.ts';
import { cyan, red, yellow } from 'https://deno.land/std/fmt/colors.ts';
import { parseXml, IError, traverse, INode } from 'https://raw.githubusercontent.com/gera2ld/xmlparse/master/mod.ts';

const builtIns = [
  'block',
  'button',
  'canvas',
  'checkbox',
  'checkbox-group',
  'cover-image',
  'cover-view',
  'form',
  'icon',
  'image',
  'import-sjs',
  'input',
  'label',
  'lottie',
  'map',
  'movable-area',
  'movable-view',
  'navigator',
  'page-meta',
  'picker',
  'picker-view',
  'picker-view-column',
  'progress',
  'radio',
  'radio-group',
  'rich-text',
  'scroll-view',
  'slider',
  'slot',
  'swiper',
  'swiper-item',
  'switch',
  'template',
  'text',
  'textarea',
  'video',
  'view',
  'web-view',
];

interface IDependency {
  node: INode;
  modulePath?: string;
}

interface IComponent {
  entry: string;
  deps: IDependency[];
  defs?: {
    components: Map<string, string>;
  };
}

interface IGraphNode {
  entry: string;
  name: string;
  weight: number;
}

interface IErrorRef {
  line?: number;
  col?: number;
  message?: string;
  content?: string[];
}

export function reprStr(error: IError): IErrorRef {
  const { input, offset, message } = error;
  const lines = input.split('\n');
  let line = 0;
  let col = offset;
  while (line < lines.length && col > lines[line].length) {
    col -= lines[line].length + 1;
    line += 1;
  }
  const start = Math.max(0, col - 100);
  const end = Math.min(col + 100, lines[line].length);
  const currentLine = lines[line];
  const codeLine = (start > 0 ? '...' : '') + currentLine.slice(start, end).replace(/^\t+/, (m: string) => '  '.repeat(m.length));
  let cursor = start > 0 ? 3 : 0;
  for (let i = start; i < col; i += 1) {
    if (currentLine.charCodeAt(i) > 127 || currentLine[i] === '\t') cursor += 2;
    else cursor += 1;
  }
  return {
    line: line + 1,
    col: col + 1,
    message,
    content: [
      codeLine,
      ' '.repeat(cursor) + '^',
    ],
  };
}

function getEntryDesc(entry: string, strip: RegExp) {
  entry = entry.replace(strip, '');
  const external = entry.startsWith('node_modules/');
  const name = external ? `<span class="external">${entry.slice(13)}</span>` : path.basename(entry);
  return { name, external };
}

export class AppXScanner {
  root: string;
  components: Map<string, IComponent>;
  errors: {
    fatal: Map<string, IErrorRef[]>;
    warning: Map<string, IErrorRef[]>;
  };
  pages: Set<string>;
  highlights?: Set<string>;

  constructor(entry: string, options: {
    highlights?: Iterable<string>;
  } = {}) {
    this.root = path.resolve(entry);
    this.components = new Map();
    this.errors = { fatal: new Map(), warning: new Map() };
    this.pages = new Set();
    this.highlights = new Set(options.highlights ?? []);
  }

  logError(entry: string, errors: IErrorRef[], type: 'fatal' | 'warning') {
    console.info(`- ${cyan(entry)}`);
    for (const error of errors) {
      const title = [
        error.line && `@${error.line}:${error.col}`,
        error.message,
      ].filter(Boolean).join(' ');
      if (title) console.info(`  ${(type === 'fatal' ? red : yellow)(title)}`);
      const content = error.content?.map(line => `  ${line}`).join('\n');
      if (content) console.info(content);
    }
  }

  async check() {
    this.errors = { fatal: new Map(), warning: new Map() };
    await this.checkApp();
    await this.checkUnused();
    let hasError = false;
    if (this.errors.warning.size) {
      console.info();
      console.info(yellow('Warnings:'));
      for (let [entry, errors] of this.errors.warning) {
        hasError = true;
        this.logError(entry, errors, 'warning');
      }
    }
    if (this.errors.fatal.size) {
      console.info();
      console.info(red('Fatal errors:'));
      for (let [entry, errors] of this.errors.fatal) {
        hasError = true;
        this.logError(entry, errors, 'fatal');
      }
    }
    if (!hasError) console.info('No error is found');
    await this.generateHierarchy();
    // await this.analyze();
  }

  async checkApp() {
    const app = JSON.parse(await this.readFile('app.json'));
    const pages = app.pages as string[];
    for (const page of pages) {
      this.pages.add(page);
      await this.checkComponent(page);
    }
  }

  async checkUnused() {
    const unused = new Set<string>();
    for await (const entry of walk(this.root, { skip: [/\/node_modules\//] })) {
      const filepath = path.posix.relative(this.root, entry.path);
      if (filepath.endsWith('.axml')) {
        const componentEntry = filepath.slice(0, -5);
        if (!this.components.has(componentEntry)) {
          unused.add(componentEntry);
        }
      }
    }
    if (unused.size > 0) {
      const title = `${unused.size} extraneous components are found`;
      for (const entry of unused) {
        this.addError(title, {
          message: entry,
        });
      }
    }
  }

  async analyze() {
    const nodeMap = new Map<string, IGraphNode>();
    const links = [];
    for (const [, component] of this.components) {
      const parts = component.entry.split('/');
      let name = parts.pop();
      if (name === 'index') name = parts.pop();
      nodeMap.set(component.entry, {
        name: name || '',
        entry: component.entry,
        weight: 0,
      });
      for (const dep of component.deps) {
        if (dep.modulePath) {
          links.push([component.entry, dep.modulePath]);
        }
      }
    }
    for (const entries of links) {
      for (const entry of entries) {
        const node = nodeMap.get(entry);
        if (node) node.weight += 1;
      }
    }
    const nodes = Array.from(nodeMap.values());
    await this.render('component-graph', { nodes, links });
  }

  async generateHierarchy() {
    const rootNode: any = {
      v: getEntryDesc(this.root, /\/src$/).name,
      c: [],
      d: 0,
    };
    const cache = new Map();
    const queue: { component: IComponent, node: any }[] = [];
    let i = 0;
    for (const page of this.pages) {
      const component = this.components.get(page);
      if (!component) continue;
      i += 1;
      const pageNode = {
        v: getEntryDesc(component.entry, /\/index(?:\.mini)?$/).name,
        c: [],
        d: 1,
        p: {
          pi: i,
          c: this.highlights?.size ? '#999' : null,
        },
      };
      queue.push({ component, node: pageNode });
      rootNode.c.push(pageNode);
    }
    while (queue.length) {
      const { component, node } = queue.shift()!;
      component.deps?.forEach(({ modulePath }) => {
        let childNode;
        if (cache.has(modulePath)) {
          childNode = cache.get(modulePath);
        } else {
          const child = this.components.get(modulePath!);
          if (child) {
            const desc = getEntryDesc(child.entry, /\/index(?:\.mini)?$/);
            childNode = {
              v: desc.name,
              c: [],
              d: node.d + 1,
              p: {
                pi: node.p.pi,
                f: desc.external,
                c: this.highlights?.has(child.entry) ? null : node.p.c,
              },
            };
            queue.push({ component: child, node: childNode });
          }
          // cache.set(modulePath, childNode);
        }
        if (childNode) node.c.push(childNode);
      });
    }
    await this.render('component-hierarchy', rootNode);
  }

  async render(key: string, data: any) {
    const template = await Deno.readTextFile(`templates/${key}.html`);
    await ensureDir('output');
    await Deno.writeTextFile(`output/${key}.html`, template.replace('{/* DATA */}', JSON.stringify(data)));
  }

  addError(entry: string, error: IErrorRef | IErrorRef[], type: 'fatal' | 'warning' = 'warning') {
    let list = this.errors[type].get(entry);
    if (!list) {
      list = [];
      this.errors[type].set(entry, list);
    }
    if (Array.isArray(error)) list.push(...error);
    else list.push(error);
  }

  async checkComponent(entry: string) {
    if (this.components.has(entry)) return;
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
    let deps: IDependency[] = [];
    if (hasError) {
      this.components.set(entry, {
        entry,
        deps,
      });
    } else {
      const defs = await this.extractDefinitions(entry);
      try {
        deps = await this.extractComponents(entry, defs.components);
      } catch (err) {
        this.addError(entry, err.error, 'fatal');
      }
      this.components.set(entry, {
        entry,
        deps,
        defs,
      });
      for (const [, modulePath] of defs.components) {
        if (!this.components.has(modulePath)) await this.checkComponent(modulePath);
      }
    }
  }

  async assertFile(entry: string) {
    let stat: Deno.FileInfo | undefined;
    try {
      stat = await Deno.stat(`${this.root}/${entry}`);
    } catch {
      // noop
    }
    if (!stat?.isFile) throw new Error(`Expect file: ${entry}`)
  }

  async readFile(entry: string) {
    try {
      const content = await Deno.readTextFile(`${this.root}/${entry}`);
      return content;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  async extractDefinitions(entry: string) {
    const def = JSON.parse(await this.readFile(`${entry}.json`));
    const components = new Map<string, string>();
    for (const [key, value] of Object.entries<string>(def.usingComponents || {})) {
      try {
        let modulePath;
        if (value.startsWith('/')) {
          modulePath = value.slice(1);
        } else if (value.startsWith('.')) {
          modulePath = path.join(path.dirname(entry), value);
        } else {
          modulePath = `node_modules/${value}`;
        }
        await this.assertFile(`${modulePath}.json`);
        components.set(key, modulePath);
      } catch {
        this.addError(entry, { message: `Component not found: ${key}` }, 'fatal');
      }
    }
    return { components };
  }

  async extractComponents(entry: string, definitions: Map<string, string>) {
    const content = await this.readFile(`${entry}.axml`);
    const result = parseXml(content);
    const { node: root, warnings } = result;
    if (warnings.length) {
      this.addError(entry, warnings.map(reprStr));
    }
    const deps = new Map<string, IDependency>();
    traverse(root, node => {
      if (node.type === 'element' && node.name) {
        if (!deps.has(node.name)) {
          deps.set(node.name, { node });
        }
        if (node.attrs) {
          for (const attr of Object.values(node.attrs)) {
            if (typeof attr.value === 'string' && attr.value.includes('{{') !== attr.value.includes('}}')) {
              this.addError(entry, reprStr({ input: content, offset: attr.position.end, message: 'Unmatched brackets' }));
            }
          }
        }
      }
      if (node.type === 'text' && node.value && node.value.includes('{{') !== node.value.includes('}}')) {
        this.addError(entry, reprStr({ input: content, offset: (node.posOpen?.end || -1) + 1, message: 'Unmatched brackets' }));
      }
    });
    const unused = new Map(definitions);
    for (const [name, component] of deps) {
      if (builtIns.includes(name)) {
        component.modulePath = `@@/${name}`;
      } else if (definitions.has(name)) {
        component.modulePath = definitions.get(name);
        unused.delete(name);
      } else {
        this.addError(entry, reprStr({ input: content, offset: (component.node.posOpen?.start ?? -1) + 1, message: `Undefined component: ${name}` }), 'fatal');
      }
    }
    for (const [name] of unused) {
      this.addError(entry, { message: `Unused definition: ${name}` });
    }
    return Array.from(deps.values());
  }
}
