// @flaky — vi.resetModules() + dynamic import contention under parallel suite execution; run with retry
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BackendToolMod from '../backend-tool.js';

const {
  getBackendStatusMock,
  shutdownBackendMock,
} = vi.hoisted(() => ({
  getBackendStatusMock: vi.fn(),
  shutdownBackendMock: vi.fn(),
}));
const TEST_PLUGIN_ROOT = '/test/plugin/root';

vi.mock('../backend-client.js', () => ({
  getBackendStatus: getBackendStatusMock,
  shutdownBackend: shutdownBackendMock,
}));

type BridgeBackendToolModule = typeof BackendToolMod;

async function loadBackendToolModule(): Promise<BridgeBackendToolModule> {
  vi.resetModules();
  return import('../backend-tool.js');
}

describe('bridge backend-tool', { retry: 2 }, () => {
  beforeEach(() => {
    getBackendStatusMock.mockReset();
    shutdownBackendMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns backend status', async () => {
    const { handleBackendToolCall } = await loadBackendToolModule();
    const status = {
      status: 'ok' as const,
      version: '0.1.0',
      bundleHash: 'abc123',
      instanceId: 'backend-instance',
      uptimeMs: 10,
      activeChildren: 1,
      activeJobs: 2,
      inflightRequests: 3,
    };
    getBackendStatusMock.mockResolvedValueOnce(status);

    await expect(handleBackendToolCall({ op: 'status' }, TEST_PLUGIN_ROOT)).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify(status) }],
      isError: false,
    });
  });

  it('returns an MCP error when backend status is unavailable', async () => {
    const { handleBackendToolCall } = await loadBackendToolModule();
    getBackendStatusMock.mockResolvedValueOnce(null);

    await expect(handleBackendToolCall({ op: 'status' }, TEST_PLUGIN_ROOT)).resolves.toEqual({
      content: [{ type: 'text', text: 'Backend is not running' }],
      isError: true,
    });
  });

  it('returns shutdown success', async () => {
    const { handleBackendToolCall } = await loadBackendToolModule();
    shutdownBackendMock.mockResolvedValueOnce({ ok: true });

    await expect(handleBackendToolCall({ op: 'shutdown' }, TEST_PLUGIN_ROOT)).resolves.toEqual({
      content: [{ type: 'text', text: JSON.stringify({ status: 'shutting_down' }) }],
      isError: false,
    });
  });

  it('returns shutdown errors as MCP errors', async () => {
    const { handleBackendToolCall } = await loadBackendToolModule();
    shutdownBackendMock.mockResolvedValueOnce({ ok: false, reason: 'not_running' });

    await expect(handleBackendToolCall({ op: 'shutdown' }, TEST_PLUGIN_ROOT)).resolves.toEqual({
      content: [{ type: 'text', text: 'not_running' }],
      isError: true,
    });
  });

  it('rejects invalid op values', async () => {
    const { handleBackendToolCall } = await loadBackendToolModule();

    const result = await handleBackendToolCall({ op: 'restart' }, TEST_PLUGIN_ROOT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid enum value/i);
  });

  it('returns zod validation errors for malformed input', async () => {
    const { handleBackendToolCall } = await loadBackendToolModule();

    const result = await handleBackendToolCall({}, TEST_PLUGIN_ROOT);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Required/i);
  });

  it('exports the backend tool descriptor', async () => {
    const { backendToolDescriptor } = await loadBackendToolModule();

    expect(backendToolDescriptor).toEqual({
      name: 'backend',
      description: 'Inspect or gracefully shut down the Coral backend daemon.',
      inputSchema: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['status', 'shutdown'],
            description: 'Backend operation to run.',
          },
        },
        required: ['op'],
      },
    });
  });

  it('buildToolList appends wait and backend tools to discovered tools', async () => {
    const { waitToolDescriptor, backendToolDescriptor, buildToolList } = await loadBackendToolModule();
    const remoteTools = [{
      name: 'codex',
      description: 'Execute a prompt with Codex CLI.',
      inputSchema: { type: 'object' },
    }];

    expect(buildToolList(remoteTools)).toEqual([...remoteTools, waitToolDescriptor, backendToolDescriptor]);
  });

  it('buildToolList returns wait and backend tools when discovery is unavailable', async () => {
    const { waitToolDescriptor, backendToolDescriptor, buildToolList } = await loadBackendToolModule();

    expect(buildToolList(null)).toEqual([waitToolDescriptor, backendToolDescriptor]);
  });
});
