// Writes docs/tools.md from the tool and prompt definitions of the built server,
// so the reference can never drift from the code. Run with: npm run docs:tools
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createDeps, createServer } from '../dist/server.js';

const config = { tokenFile: '', configDir: '', allowWrite: true, brandTerms: [] };
const server = createServer(createDeps(config));
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'docs-generator', version: '1.0.0' });
await server.connect(serverTransport);
await client.connect(clientTransport);

const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
await client.close();
await server.close();

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function typeOf(schema) {
  if (!schema) return '';
  if (schema.enum) return schema.enum.map((value) => `\`${value}\``).join(', ');
  if (schema.type === 'array') {
    const items = schema.items ?? {};
    if (items.enum) return `list of ${items.enum.map((value) => `\`${value}\``).join(', ')}`;
    if (items.type === 'object') return 'list of filters';
    return `list of ${items.type ?? 'values'}`;
  }
  if (schema.anyOf) return schema.anyOf.map(typeOf).filter(Boolean).join(' or ');
  return schema.type ?? '';
}

function range(schema) {
  const parts = [];
  if (schema.minimum !== undefined) parts.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) parts.push(`max ${schema.maximum}`);
  if (schema.maxItems !== undefined) parts.push(`up to ${schema.maxItems}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

const lines = [
  '# Tool reference',
  '',
  'Generated from the server by `npm run docs:tools`. Do not edit by hand.',
  '',
  'Every tool returns a JSON document. Tables inside it have the shape `{"columns": [...], "rows": [[...], ...]}`.',
  'CTR values are percentages, position is the average topmost position (lower is better), and dates are Pacific Time.',
  '',
  '## Parameters shared by most tools',
  '',
  '- `site_url`: the property. An exact name (`sc-domain:example.com`, `https://www.example.com/`), a bare domain or any page URL on the site. Optional when `GSC_SITE_URL` is set or the account has one property.',
  '- `start_date`, `end_date`, `days`: the period. With none given, the 28 days ending on the last day Google has complete data for. `end_date` also accepts `today` and `yesterday`.',
  '- `filters`: a list of `{"dimension", "operator", "expression"}` objects that must all match. Dimensions: `query`, `page`, `country`, `device`, `searchAppearance`. Operators: `equals` (default), `notEquals`, `contains`, `notContains`, `includingRegex`, `excludingRegex`.',
  '- `search_type`: `web` (default), `image`, `video`, `news`, `discover` or `googleNews`.',
  '',
  '## Tools',
  '',
  ...tools.map((tool) => `- [\`${tool.name}\`](#${tool.name})`),
  '',
];

for (const tool of tools) {
  const properties = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const access = tool.annotations?.readOnlyHint
    ? 'Read-only.'
    : tool.annotations?.destructiveHint
      ? 'Removes data. Available only with `GSC_ALLOW_WRITE=true`.'
      : 'Changes data. Available only with `GSC_ALLOW_WRITE=true`.';

  lines.push(`### ${tool.name}`, '', `**${tool.title ?? tool.name}.** ${tool.description}`, '', access, '');
  const names = Object.keys(properties);
  if (names.length === 0) {
    lines.push('No parameters.', '');
    continue;
  }
  lines.push('| Parameter | Type | Default | Description |', '|---|---|---|---|');
  for (const name of names) {
    const schema = properties[name];
    const isRequired = required.has(name) && schema.default === undefined;
    const fallback = schema.default === undefined ? (isRequired ? '**required**' : '') : `\`${JSON.stringify(schema.default)}\``;
    lines.push(`| \`${name}\` | ${cell(typeOf(schema))}${range(schema)} | ${cell(fallback)} | ${cell(schema.description)} |`);
  }
  lines.push('');
}

lines.push('## Prompts', '');
for (const prompt of prompts) {
  const args = (prompt.arguments ?? []).map((arg) => `\`${arg.name}\`${arg.required ? ' (required)' : ''}`).join(', ');
  lines.push(`### ${prompt.name}`, '', `**${prompt.title ?? prompt.name}.** ${prompt.description}`, '', args ? `Arguments: ${args}.` : 'No arguments.', '');
}

await writeFile(new URL('../docs/tools.md', import.meta.url), `${lines.join('\n').trimEnd()}\n`);
console.log(`docs/tools.md: ${tools.length} tools, ${prompts.length} prompts`);
