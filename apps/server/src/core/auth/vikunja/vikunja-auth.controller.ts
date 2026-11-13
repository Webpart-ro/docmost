import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../../../integrations/throttle/throttler-names';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  VIKUNJA_LOGIN_TTL_MS,
  VikunjaAuthError,
  VikunjaAuthService,
} from './vikunja-auth.service';

export const VIKUNJA_STATE_COOKIE = 'vikunja_login';
const VIKUNJA_COOKIE_PATH = '/api/auth/vikunja';

@Controller('auth/vikunja')
export class VikunjaAuthController {
  private readonly logger = new Logger(VikunjaAuthController.name);

  constructor(
    private readonly vikunjaAuthService: VikunjaAuthService,
    private readonly environmentService: EnvironmentService,
  ) {}

  @Get('login')
  async login(@Res() res: FastifyReply, @Query('redirect') redirect?: string) {
    if (!this.vikunjaAuthService.isEnabled()) {
      throw new NotFoundException();
    }

    const { authorizeUrl, stateCookie } =
      this.vikunjaAuthService.createLoginRequest(redirect);

    res.setCookie(VIKUNJA_STATE_COOKIE, stateCookie, {
      httpOnly: true,
      // lax: the callback is a top-level GET navigation coming back from Vikunja
      sameSite: 'lax',
      path: VIKUNJA_COOKIE_PATH,
      secure: this.environmentService.isHttps(),
      expires: new Date(Date.now() + VIKUNJA_LOGIN_TTL_MS),
    });

    return res.redirect(authorizeUrl, 302);
  }

  @SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
  @UseGuards(ThrottlerGuard)
  @Get('callback')
  async callback(
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') providerError?: string,
  ) {
    const stateCookie = req.cookies?.[VIKUNJA_STATE_COOKIE];
    // single use: whatever happens next, this login attempt is over
    res.clearCookie(VIKUNJA_STATE_COOKIE, { path: VIKUNJA_COOKIE_PATH });

    try {
      if (providerError) {
        throw new VikunjaAuthError('access_denied');
      }

      const { authToken, returnPath } =
        await this.vikunjaAuthService.completeLogin({
          code,
          state,
          stateCookie,
          workspace,
        });

      this.setAuthCookie(res, authToken);
      return res.redirect(returnPath ?? '/home', 302);
    } catch (err) {
      const errorCode =
        err instanceof VikunjaAuthError ? err.code : 'unexpected_error';
      if (!(err instanceof VikunjaAuthError)) {
        this.logger.error('Vikunja login failed', err as Error);
      } else {
        this.logger.warn(`Vikunja login rejected: ${errorCode}`);
      }
      return res.redirect(
        `/login?sso_error=${encodeURIComponent(errorCode)}`,
        302,
      );
    }
  }

  // Mirrors AuthController.setAuthCookie so the session is identical to a password login.
  private setAuthCookie(res: FastifyReply, token: string) {
    res.setCookie('authToken', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });
  }
}
