import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { jsonToMarkdown } from '../../collaboration/collaboration.util';

/**
 * Calls an existing Docmost REST endpoint as the MCP caller. Implemented by
 * McpController via Fastify inject, so every tool goes through the same
 * guards, DTO validation, CASL / page permissions and audit trail as the UI.
 */
export type DocmostApiCall = (path: string, body?: object) => Promise<any>;

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

function textToProsemirror(text: string) {
  return {
    type: 'doc',
    content: text.split(/\n{2,}/).map((para) => ({
      type: 'paragraph',
      content: para.trim() ? [{ type: 'text', text: para.trim() }] : [],
    })),
  };
}

function safeMarkdown(content: unknown): unknown {
  if (!content) return content;
  try {
    const json = typeof content === 'string' ? JSON.parse(content) : content;
    return jsonToMarkdown(json);
  } catch {
    return content;
  }
}

function pickPage(page: any) {
  if (!page) return page;
  return {
    id: page.id,
    slugId: page.slugId,
    title: page.title,
    icon: page.icon,
    spaceId: page.spaceId,
    space: page.space
      ? { id: page.space.id, name: page.space.name, slug: page.space.slug }
      : undefined,
    parentPageId: page.parentPageId,
    creator: page.creator?.name,
    lastUpdatedBy: page.lastUpdatedBy?.name,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    permissions: page.permissions,
    content: page.content,
  };
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export function buildDocmostMcpServer(
  call: DocmostApiCall,
  appUrl: string,
): McpServer {
  const server = new McpServer(
    { name: 'webpart-docs', version: '1.0.0' },
    {
      instructions:
        'Webpart Docs (Docmost) wiki. Page ids accept either the UUID or the ' +
        `short slugId at the end of a page URL (${appUrl}/s/<space>/p/<title>-<slugId>). ` +
        'Page content is read and written as Markdown.',
    },
  );

  server.registerTool(
    'list_spaces',
    {
      title: 'List spaces',
      description: 'List the spaces the caller is a member of.',
      inputSchema: z.object({}),
      annotations: READ,
    },
    wrap(async () => {
      const res = await call('/spaces', { limit: 100 });
      return (res?.items ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        description: s.description,
      }));
    }),
  );

  server.registerTool(
    'search',
    {
      title: 'Search pages',
      description: 'Full-text search across pages the caller can read.',
      inputSchema: z.object({
        query: z.string().min(1),
        spaceId: z.string().uuid().optional(),
        titleOnly: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: READ,
    },
    wrap(async ({ query, spaceId, titleOnly, limit }) => {
      const res = await call('/search', {
        query,
        spaceId,
        titleOnly,
        limit: limit ?? 20,
      });
      const items = Array.isArray(res) ? res : (res?.items ?? []);
      return items.map((r: any) => ({
        id: r.id,
        slugId: r.slugId,
        title: r.title,
        space: r.space?.name,
        spaceId: r.space?.id ?? r.spaceId,
        highlight: r.highlight,
        updatedAt: r.updatedAt,
      }));
    }),
  );

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description:
        'List pages in a space (root level), or the children of parentPageId.',
      inputSchema: z.object({
        spaceId: z.string().uuid(),
        parentPageId: z.string().optional(),
      }),
      annotations: READ,
    },
    wrap(async ({ spaceId, parentPageId }) => {
      const res = await call('/pages/sidebar-pages', {
        spaceId,
        pageId: parentPageId,
      });
      return (res?.items ?? []).map((p: any) => ({
        id: p.id,
        slugId: p.slugId,
        title: p.title,
        parentPageId: p.parentPageId,
        hasChildren: p.hasChildren,
      }));
    }),
  );

  server.registerTool(
    'get_page',
    {
      title: 'Get page',
      description: 'Read a page with its content as Markdown.',
      inputSchema: z.object({ pageId: z.string().min(1) }),
      annotations: READ,
    },
    wrap(async ({ pageId }) => {
      const page = await call('/pages/info', {
        pageId,
        includeContent: true,
        includeSpace: true,
        format: 'markdown',
      });
      return pickPage(page);
    }),
  );

  server.registerTool(
    'get_breadcrumbs',
    {
      title: 'Get breadcrumbs',
      description: 'The ancestor chain of a page, root first.',
      inputSchema: z.object({ pageId: z.string().min(1) }),
      annotations: READ,
    },
    wrap(async ({ pageId }) => {
      const res = await call('/pages/breadcrumbs', { pageId });
      return (res ?? []).map((p: any) => ({
        id: p.id,
        slugId: p.slugId,
        title: p.title,
      }));
    }),
  );

  server.registerTool(
    'create_page',
    {
      title: 'Create page',
      description: 'Create a page from Markdown, optionally under a parent.',
      inputSchema: z.object({
        spaceId: z.string().uuid(),
        title: z.string().min(1),
        markdown: z.string().optional(),
        parentPageId: z.string().optional(),
        icon: z.string().optional(),
      }),
      annotations: WRITE,
    },
    wrap(async ({ spaceId, title, markdown, parentPageId, icon }) => {
      const page = await call('/pages/create', {
        spaceId,
        title,
        icon,
        parentPageId,
        ...(markdown !== undefined
          ? { content: markdown, format: 'markdown' }
          : {}),
      });
      const { content: _content, ...rest } = pickPage(page);
      return { ...rest, url: `${appUrl}/p/${page.slugId}` };
    }),
  );

  server.registerTool(
    'update_page',
    {
      title: 'Update page',
      description:
        'Change a page title/icon and/or content. Content is Markdown; ' +
        'operation replace (default) overwrites, append/prepend add to it.',
      inputSchema: z.object({
        pageId: z.string().min(1),
        title: z.string().min(1).optional(),
        icon: z.string().optional(),
        markdown: z.string().optional(),
        operation: z.enum(['replace', 'append', 'prepend']).optional(),
      }),
      annotations: { ...WRITE, destructiveHint: true },
    },
    wrap(async ({ pageId, title, icon, markdown, operation }) => {
      const page = await call('/pages/update', {
        pageId,
        title,
        icon,
        ...(markdown !== undefined
          ? {
              content: markdown,
              format: 'markdown',
              operation: operation ?? 'replace',
            }
          : {}),
      });
      const { content: _content, ...rest } = pickPage(page);
      return rest;
    }),
  );

  server.registerTool(
    'list_comments',
    {
      title: 'List comments',
      description: 'List comments on a page, content as plain Markdown.',
      inputSchema: z.object({ pageId: z.string().min(1) }),
      annotations: READ,
    },
    wrap(async ({ pageId }) => {
      const res = await call('/comments', { pageId, limit: 100 });
      return (res?.items ?? []).map((c: any) => ({
        id: c.id,
        parentCommentId: c.parentCommentId,
        author: c.creator?.name,
        selection: c.selection,
        content: safeMarkdown(c.content),
        resolvedAt: c.resolvedAt,
        createdAt: c.createdAt,
      }));
    }),
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Add comment',
      description:
        'Add a page-level comment, or a reply when parentCommentId is set.',
      inputSchema: z.object({
        pageId: z.string().min(1),
        text: z.string().min(1),
        parentCommentId: z.string().uuid().optional(),
      }),
      annotations: WRITE,
    },
    wrap(async ({ pageId, text, parentCommentId }) => {
      const comment = await call('/comments/create', {
        pageId,
        type: 'page',
        parentCommentId,
        content: JSON.stringify(textToProsemirror(text)),
      });
      return { id: comment?.id, pageId, parentCommentId };
    }),
  );

  return server;
}
