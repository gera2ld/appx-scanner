import * as path from 'https://deno.land/std/path/mod.ts';
import { red, yellow } from 'https://deno.land/std/fmt/colors.ts';
import { parseXml, IError, traverse, reprStr, INode } from 'https://raw.githubusercontent.com/gera2ld/xmlparse/master/mod.ts';

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

export class AppXScanner {
  root: string;
  components: Map<string, IComponent>;
  errors: { [key: string]: IError[] };

  constructor(entry: string) {
    this.root = entry;
    this.components = new Map();
    this.errors = {};
  }

  logError(entry: string, errors: IError[]) {
    console.info(`- ${red(entry)}`);
    for (const error of errors) {
      const title = [
        error.line && yellow(`@${error.line}:${error.col}`),
        error.message,
      ].filter(Boolean).join(' ');
      if (title) console.info(`  ${title}`);
      const content = error.content?.split('\n').map(line => `  ${line}`).join('\n');
      if (content) console.info(`\n${content}\n`);
    }
  }

  async check() {
    this.errors = {};
    await this.checkApp();
    let hasError = false;
    console.info();
    for (const [entry, errors] of Object.entries(this.errors)) {
      hasError = true;
      this.logError(entry, errors);
    }
    if (!hasError) console.info('No error is found');
    await this.analyze();
  }

  async checkApp() {
    const app = JSON.parse(await this.readFile('app.json'));
    const pages = app.pages as string[];
    for (const page of pages) {
      await this.checkComponent(page);
    }
  }

  async analyze() {
    const nodes = new Set<string>();
    const links = [];
    for (const [, component] of this.components) {
      nodes.add(component.entry);
      for (const dep of component.deps) {
        if (dep.modulePath) {
          links.push([component.entry, dep.modulePath]);
        }
      }
    }
    // console.log(nodes, links);
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

  async checkComponent(entry: string) {
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
      const defs = await this.extractDefinitions(entry);
      let deps;
      try {
        deps = await this.extractComponents(entry, defs.components);
      } catch (err) {
        this.addError(entry, err.error);
      }
      this.components.set(entry, {
        entry,
        deps: deps || [],
        defs,
      });
      for (const [, modulePath] of defs.components) {
        if (!this.components.has(modulePath)) await this.checkComponent(modulePath);
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
          modulePath = `@/${value}`;
        }
        await this.assertFile(`${modulePath}.json`);
        components.set(key, modulePath);
      } catch {
        this.addError(entry, { message: `Component not found: ${key}` });
      }
    }
    return { components };
  }

  async extractComponents(entry: string, definitions: Map<string, string>) {
    const content = await this.readFile(`${entry}.axml`);
    const result = parseXml(content);
    const { node: root, warnings } = result;
    if (warnings.length) {
      this.addError(entry, warnings);
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
              this.addError(entry, reprStr(content, attr.position.end, 'Unmatched brackets'));
            }
          }
        }
      }
      if (node.type === 'text' && node.value && node.value.includes('{{') !== node.value.includes('}}')) {
        this.addError(entry, reprStr(content, (node.posOpen?.end || -1) + 1, 'Unmatched brackets'));
      }
    });
    for (const [name, component] of deps) {
      if (builtIns.includes(name)) {
        component.modulePath = `@@/${name}`;
      } else if (definitions.has(name)) {
        component.modulePath = definitions.get(name);
      } else {
        this.addError(entry, reprStr(content, (component.node.posOpen?.start ?? -1) + 1, `Undefined component: ${name}`));
      }
    }
    return Array.from(deps, ([, dep]) => dep);
  }
}
