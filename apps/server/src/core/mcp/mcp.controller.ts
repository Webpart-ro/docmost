import {
  All,
  Controller,
  Logger,
  OnModuleDestroy,
  Req,
  Res,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createMcpHandler, McpHttpHandler } from '@modelcontextprotocol/server';
import { TokenService } from '../auth/services/token.service';
import { JwtApiKeyPayload, JwtType } from '../auth/dto/jwt-payload';
import { ApiTokenService } from '../api-token/api-token.service';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { extractBearerTokenFromHeader } from '../../common/helpers';
import { buildDocmostMcpServer, DocmostApiCall } from './mcp-tools';

type McpAuthExtra = { host?: string };

/**
 * Streamable HTTP MCP endpoint at /mcp (outside the /api prefix, see main.ts).
 * Auth: `Authorization: Bearer <API token>` created under Settings → API tokens.
 */
@Controller()
export class McpController implements OnModuleDestroy {
  private readonly logger = new Logger(McpController.name);
  private readonly handler: McpHttpHandler;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly tokenService: TokenService,
    private readonly apiTokenService: ApiTokenService,
    private readonly environmentService: EnvironmentService,
  ) {
    this.handler = createMcpHandler(
      (ctx) => {
        const token = ctx.authInfo?.token;
        const extra = (ctx.authInfo?.extra ?? {}) as McpAuthExtra;
        return buildDocmostMcpServer(
          this.makeApiCall(token, extra.host),
          this.environmentService.getAppUrl(),
        );
      },
      {
        onerror: (err) => this.logger.warn(`mcp: ${err.message}`),
      },
    );
  }

  async onModuleDestroy() {
    await this.handler.close();
  }

  @All('mcp')
  async handle(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const token = extractBearerTokenFromHeader(req);
    const authed = token ? await this.authenticate(token, req) : false;

    if (!authed) {
      return reply
        .status(401)
        .header(
          'WWW-Authenticate',
          'Bearer realm="webpart-docs", error="invalid_token"',
        )
        .send({
          error: 'invalid_token',
          message:
            'Send Authorization: Bearer <API token> (Settings → API tokens).',
        });
    }

    const request = this.toWebRequest(req);
    const response = await this.handler.fetch(request, {
      parsedBody: req.method === 'POST' ? req.body : undefined,
      authInfo: {
        token,
        clientId: 'api-token',
        scopes: ['read', 'write'],
        extra: { host: req.headers.host } satisfies McpAuthExtra,
      },
    });

    reply.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'content-length') return;
      reply.header(key, value);
    });

    if (!response.body) {
      return reply.send();
    }
    return reply.send(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
    );
  }

  private async authenticate(
    token: string,
    req: FastifyRequest,
  ): Promise<boolean> {
    try {
      const payload = (await this.tokenService.verifyJwt(
        token,
        JwtType.API_KEY,
      )) as JwtApiKeyPayload;

      const workspaceId = (req.raw as any).workspaceId;
      if (workspaceId && workspaceId !== payload.workspaceId) {
        return false;
      }

      await this.apiTokenService.validateApiKey(payload);
      return true;
    } catch {
      return false;
    }
  }

  private toWebRequest(req: FastifyRequest): Request {
    const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
    const url = `${proto}://${req.headers.host ?? 'localhost'}${req.url}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    }

    const hasBody = req.method === 'POST' && req.body !== undefined;
    return new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });
  }

  /**
   * Forwards a tool call to the internal REST API with the caller's token,
   * so the regular JwtAuthGuard, validation and permission checks apply.
   */
  private makeApiCall(token: string, host?: string): DocmostApiCall {
    return async (path, body = {}) => {
      const fastify = this.httpAdapterHost.httpAdapter.getInstance();
      const res = await fastify.inject({
        method: 'POST',
        url: `/api${path}`,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(host ? { host } : {}),
        },
        payload: JSON.stringify(body),
      });

      let json: any;
      try {
        json = res.json();
      } catch {
        json = undefined;
      }

      if (res.statusCode >= 400) {
        const message = json?.message ?? res.body ?? `HTTP ${res.statusCode}`;
        throw new Error(
          `${path} failed (${res.statusCode}): ${
            Array.isArray(message) ? message.join('; ') : message
          }`,
        );
      }

      return json?.data ?? json;
    };
  }
}
