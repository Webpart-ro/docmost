import { buildDocmostMcpServer } from './mcp-tools';

// Reach the registered tool handlers without spinning up a transport.
function tools(server: any): Record<string, any> {
  return server._registeredTools ?? server.registeredTools ?? {};
}

async function callTool(server: any, name: string, args: object) {
  const tool = tools(server)[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  const handler = tool.handler ?? tool.callback ?? tool.cb;
  return handler(args, {});
}

describe('buildDocmostMcpServer', () => {
  it('registers the expected tools', () => {
    const server = buildDocmostMcpServer(jest.fn(), 'https://n.example');
    expect(Object.keys(tools(server)).sort()).toEqual(
      [
        'add_comment',
        'create_page',
        'get_breadcrumbs',
        'get_page',
        'list_comments',
        'list_pages',
        'list_spaces',
        'search',
        'update_page',
      ].sort(),
    );
  });

  it('get_page forwards to /pages/info as markdown', async () => {
    const call = jest.fn().mockResolvedValue({
      id: 'p1',
      slugId: 'abc123',
      title: 'Hello',
      content: '# Hello',
    });
    const server = buildDocmostMcpServer(call, 'https://n.example');
    const result = await callTool(server, 'get_page', { pageId: 'abc123' });

    expect(call).toHaveBeenCalledWith('/pages/info', {
      pageId: 'abc123',
      includeContent: true,
      includeSpace: true,
      format: 'markdown',
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).content).toBe('# Hello');
  });

  it('update_page sends markdown with replace by default', async () => {
    const call = jest.fn().mockResolvedValue({ id: 'p1', slugId: 's' });
    const server = buildDocmostMcpServer(call, 'https://n.example');
    await callTool(server, 'update_page', { pageId: 'p1', markdown: 'x' });

    expect(call).toHaveBeenCalledWith(
      '/pages/update',
      expect.objectContaining({
        pageId: 'p1',
        content: 'x',
        format: 'markdown',
        operation: 'replace',
      }),
    );
  });

  it('returns API errors as tool errors instead of throwing', async () => {
    const call = jest
      .fn()
      .mockRejectedValue(new Error('/pages/info failed (403): Forbidden'));
    const server = buildDocmostMcpServer(call, 'https://n.example');
    const result = await callTool(server, 'get_page', { pageId: 'x' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('403');
  });
});
