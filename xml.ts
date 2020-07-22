export interface IAttributes {
  [key: string]: string | boolean;
}

export interface INode {
  type: 'element' | 'text' | 'comment';
  name?: string;
  attrs?: IAttributes;
  children?: INode[];
  value?: string;
}

export interface ITag {
  name: string;
  attrs?: IAttributes;
  isClosed: boolean;
  isClose: boolean;
  isComment: boolean;
  start: number,
  end: number,
}

export interface IError {
  line?: number;
  col?: number;
  message?: string;
  content?: string;
}

const WHITE_SPACE = ' \t\r\n';
const TAG_END = '/>';
const WHITE_SPACE_OR_TAG_END = WHITE_SPACE + TAG_END;

class AssertionError extends Error {
  error?: IError;

  constructor(error?: IError, message?: string) {
    super(message);
    this.error = error;
  }
}

function assert(value: any, callback?: () => IError) {
  if (!value) {
    throw new AssertionError(callback?.(), 'Assertion failed');
  }
}

function reprStr(input: string, offset: number, message?: string): IError {
  const lines = input.split('\n');
  let line = 0;
  let col = offset;
  while (line < lines.length && col > lines[line].length) {
    col -= lines[line].length + 1;
    line += 1;
  }
  const start = Math.max(0, col - 40);
  const end = Math.min(col + 40, lines[line].length);
  return {
    line,
    col,
    message,
    content: [
      (start > 0 ? '...' : '') + lines[line].slice(start, end),
      ' '.repeat(start > 0 ? col - start + 3 : col) + '^',
    ].join('\n'),
  };
}

function findNext(input: string, chars: string, offset = 0, offsetEnd = -1): number {
  if (offsetEnd < 0) offsetEnd = input.length;
  let index = offset;
  while (index < offsetEnd && !chars.includes(input[index])) index += 1;
  return index;
}

function scanTag(input: string, offset: number): [ITag, IError[]] {
  const warnings: IError[] = [];
  assert(input[offset] === '<', () => reprStr(input, offset));
  const attrs: IAttributes = {};
  const tag: ITag = {
    name: '',
    attrs,
    isClosed: false,
    isClose: false,
    isComment: false,
    start: offset,
    end: -1,
  };
  offset += 1;
  if (input[offset] === '/') {
    tag.isClose = true;
    offset += 1;
  } else if (input[offset] === '!') {
    // comment element
    assert(input.slice(offset, offset + 3) === '!--');
    const end = input.indexOf('-->', offset + 3);
    assert(end > 0);
    tag.end = end + 2;
    tag.isComment = true;
    tag.isClosed = true;
    return [tag, warnings];
  }
  let sep = findNext(input, WHITE_SPACE_OR_TAG_END, offset);
  tag.name = input.slice(offset, sep);
  while (WHITE_SPACE.includes(input[sep])) {
    while (WHITE_SPACE.includes(input[sep])) sep += 1;
    if (TAG_END.includes(input[sep])) break;
    let nextSep = findNext(input, WHITE_SPACE_OR_TAG_END + '=', sep + 1);
    const key = input.slice(sep, nextSep);
    if (key in attrs) {
      warnings.push(reprStr(input, nextSep, `Duplicate key: ${key}`));
    }
    if (input[nextSep] === '=') {
      sep = nextSep;
      nextSep = sep + 1;
      const firstChar = input[nextSep];
      let quote;
      if ('\'"'.includes(firstChar)) {
        quote = firstChar;
        nextSep += 1;
      }
      nextSep = findNext(input, quote || WHITE_SPACE_OR_TAG_END, nextSep);
      if (quote) {
        assert(input[nextSep] === quote, () => reprStr(input, nextSep));
        nextSep += 1;
        assert(WHITE_SPACE_OR_TAG_END.includes(input[nextSep]), () => reprStr(input, nextSep));
      }
      let value = input.slice(sep + 1, nextSep);
      if (quote) value = value.slice(1, -1);
      if (value.includes('{{') !== value.includes('}}')) {
        warnings.push(reprStr(input, nextSep, 'Unmatched brackets'));
      }
      attrs[key] = value.trim();
    } else {
      attrs[key] = true;
    }
    sep = nextSep;
  }
  if (input[sep] === '/') {
    tag.isClosed = true;
    sep += 1;
  }
  tag.end = sep;
  return [tag, warnings];
}

export function parseXml(input: string): [INode, IError[]] {
  const stack: INode[] = [{
    type: 'element',
    children: [],
  }];
  let offset = 0;
  let warnings: IError[] = [];
  while (offset < input.length) {
    const tagStart = findNext(input, '<', offset);
    const value = input.slice(offset, tagStart).trim();
    const current = stack[stack.length - 1];
    if (value) {
      current.children?.push({ type: 'text', value });
      if (value.includes('{{') !== value.includes('}}')) {
        warnings.push(reprStr(input, offset, 'Unmatched brackets'));
      }
    }
    if (tagStart >= input.length) break;
    const [{
      name,
      attrs,
      isClosed,
      isClose,
      isComment,
      end,
    }, scanWarnings] = scanTag(input, tagStart);
    warnings.push(...scanWarnings);
    const node: INode = {
      name,
      attrs,
      type: isComment ? 'comment' : 'element',
      children: [],
    };
    if (isClose) {
      assert(current.name === name, () => reprStr(input, tagStart));
      stack.pop();
    } else {
      assert(current.children);
      current.children?.push(node);
      if (!isClosed) stack.push(node);
    }
    offset = end + 1;
  }
  assert(stack.length === 1);
  return [stack[0], warnings];
}
