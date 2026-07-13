// Small, fully local engineering utilities. Expressions are parsed rather than
// evaluated, so no code execution or network access is possible.

import type { EngineeringRequest, EngineeringResult } from '../shared/types';

type Token = { kind: 'number'; value: number } | { kind: 'op'; value: string } | { kind: 'name'; value: string };

export function solveEngineering(request: EngineeringRequest): EngineeringResult {
  try {
    const value = request.kind === 'calculate'
      ? calculate(request.expression)
      : convert(request.value, request.from, request.to);
    if (!Number.isFinite(value)) throw new Error('Result is not finite.');
    return { ok: true, value, display: formatNumber(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not solve that.' };
  }
}

export function calculate(expression: string): number {
  const input = expression.trim();
  if (!input || input.length > 200) throw new Error('Enter a shorter expression.');
  const tokens = tokenize(input);
  let index = 0;

  const peek = (): Token | undefined => tokens[index];
  const take = (): Token => {
    const token = tokens[index++];
    if (!token) throw new Error('Unexpected end of expression.');
    return token;
  };

  const primary = (): number => {
    const token = take();
    if (token.kind === 'number') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'pi') return Math.PI;
      if (token.value === 'e') return Math.E;
      throw new Error(`Unknown constant: ${token.value}`);
    }
    if (token.kind === 'op' && token.value === '(') {
      const value = expressionLevel();
      const close = take();
      if (close.kind !== 'op' || close.value !== ')') throw new Error('Missing closing parenthesis.');
      return value;
    }
    throw new Error('Expected a number or parenthesis.');
  };

  const unary = (): number => {
    const token = peek();
    if (token?.kind === 'op' && (token.value === '+' || token.value === '-')) {
      take();
      const value = unary();
      return token.value === '-' ? -value : value;
    }
    return primary();
  };

  const power = (): number => {
    const left = unary();
    const token = peek();
    if (token?.kind === 'op' && token.value === '^') {
      take();
      return left ** power();
    }
    return left;
  };

  const term = (): number => {
    let value = power();
    while (peek()?.kind === 'op' && (peek() as { value: string }).value.match(/^[*/%]$/)) {
      const op = take().value;
      const right = power();
      if ((op === '/' || op === '%') && right === 0) throw new Error('Division by zero.');
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  };

  const expressionLevel = (): number => {
    let value = term();
    while (peek()?.kind === 'op' && ((peek() as { value: string }).value === '+' || (peek() as { value: string }).value === '-')) {
      const op = take().value;
      const right = term();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };

  const result = expressionLevel();
  if (index !== tokens.length) throw new Error('Unexpected token.');
  return result;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const rest = input.slice(cursor);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) { cursor += whitespace[0].length; continue; }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      cursor += number[0].length;
      continue;
    }
    const name = rest.match(/^[a-z]+/i);
    if (name) {
      tokens.push({ kind: 'name', value: name[0].toLowerCase() });
      cursor += name[0].length;
      continue;
    }
    const op = rest[0];
    if ('+-*/%^()'.includes(op)) {
      tokens.push({ kind: 'op', value: op });
      cursor += 1;
      continue;
    }
    throw new Error(`Unsupported character: ${op}`);
  }
  return tokens;
}

const LINEAR_UNITS: Record<string, { family: string; factor: number }> = {
  mm: { family: 'length', factor: 0.001 }, cm: { family: 'length', factor: 0.01 },
  m: { family: 'length', factor: 1 }, km: { family: 'length', factor: 1000 },
  in: { family: 'length', factor: 0.0254 }, ft: { family: 'length', factor: 0.3048 },
  yd: { family: 'length', factor: 0.9144 }, mi: { family: 'length', factor: 1609.344 },
  mg: { family: 'mass', factor: 0.000001 }, g: { family: 'mass', factor: 0.001 },
  kg: { family: 'mass', factor: 1 }, oz: { family: 'mass', factor: 0.028349523125 },
  lb: { family: 'mass', factor: 0.45359237 },
  ms: { family: 'time', factor: 0.001 }, s: { family: 'time', factor: 1 },
  min: { family: 'time', factor: 60 }, h: { family: 'time', factor: 3600 },
  day: { family: 'time', factor: 86400 },
  b: { family: 'data', factor: 1 }, kb: { family: 'data', factor: 1000 },
  mb: { family: 'data', factor: 1_000_000 }, gb: { family: 'data', factor: 1_000_000_000 },
  kib: { family: 'data', factor: 1024 }, mib: { family: 'data', factor: 1_048_576 },
  gib: { family: 'data', factor: 1_073_741_824 },
};

export function convert(value: number, fromRaw: string, toRaw: string): number {
  if (!Number.isFinite(value)) throw new Error('Enter a finite value.');
  const from = fromRaw.trim().toLowerCase().replace('°', '');
  const to = toRaw.trim().toLowerCase().replace('°', '');
  if (['c', 'f', 'k'].includes(from) || ['c', 'f', 'k'].includes(to)) {
    if (!['c', 'f', 'k'].includes(from) || !['c', 'f', 'k'].includes(to)) {
      throw new Error('Temperature units can convert only to other temperatures.');
    }
    const celsius = from === 'c' ? value : from === 'f' ? (value - 32) * 5 / 9 : value - 273.15;
    return to === 'c' ? celsius : to === 'f' ? celsius * 9 / 5 + 32 : celsius + 273.15;
  }
  const source = LINEAR_UNITS[from];
  const target = LINEAR_UNITS[to];
  if (!source || !target) throw new Error('Unknown unit.');
  if (source.family !== target.family) throw new Error('Units belong to different measurement families.');
  return value * source.factor / target.factor;
}

function formatNumber(value: number): string {
  const magnitude = Math.abs(value);
  if ((magnitude > 0 && magnitude < 0.000001) || magnitude >= 1e12) return value.toExponential(8);
  return Number(value.toPrecision(12)).toString();
}
