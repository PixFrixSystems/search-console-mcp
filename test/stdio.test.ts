import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

// These tests run the built package the way an MCP client does. Run "npm run build" first.
const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const built = existsSync(ENTRY);

/** No real credentials: the key path does not exist, so tools fail fast without touching the network. */
const ENV = {
  GSC_SERVICE_ACCOUNT_KEY: join(tmpdir(), 'search-console-mcp-test', 'missing-key.json'),
  GSC_CONFIG_DIR: join(tmpdir(), 'search-console-mcp-test'),
};

describe.skipIf(!built)('built server over stdio', () => {
  it('serves a current MCP client', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env: ENV, stderr: 'ignore' });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe('search-console-mcp');
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(16);

      const result = await client.callTool({ name: 'list_sites', arguments: {} });
      const text = (result.content as { text: string }[])[0]?.text ?? '';
      expect(result.isError).toBe(true);
      expect(text).toContain('Cannot read the service account key');
      expect(text).toContain('How to fix:');
    } finally {
      await client.close();
    }
  });

  it('still answers the older initialize handshake that most clients use today', async () => {
    const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, ...ENV }, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map<number, (message: any) => void>();
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      }
    });
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (id: number, method: string, params: object) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No answer to ${method}`)), 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        send({ jsonrpc: '2.0', id, method, params });
      });

    try {
      const initialized = await request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'legacy-client', version: '1.0.0' },
      });
      expect(initialized.result.protocolVersion).toBe('2025-06-18');
      expect(initialized.result.serverInfo.name).toBe('search-console-mcp');
      expect(initialized.result.instructions).toMatch(/Search Console/);

      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const listed = await request(2, 'tools/list', {});
      expect(listed.result.tools).toHaveLength(16);
      const quickWins = listed.result.tools.find((tool: { name: string }) => tool.name === 'find_quick_wins');
      expect(quickWins.inputSchema.properties.target_position.default).toBe(3);

      const prompts = await request(3, 'prompts/list', {});
      expect(prompts.result.prompts).toHaveLength(6);
    } finally {
      child.kill();
    }
  });

  it('prints nothing but protocol messages on stdout', async () => {
    const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, ...ENV }, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(output).toBe('');
    // Closing stdin is how a client says goodbye; the server must exit on its own.
    expect(code).toBe(0);
  });
});
