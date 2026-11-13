import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  EncryptionPurpose,
  EncryptionService,
} from '../../../integrations/encryption/encryption.service';
import { SessionService } from '../../session/session.service';
import { SignupService } from '../services/signup.service';
import { isUserDisabled } from '../../../common/helpers';
import { validateAllowedEmail } from '../auth.util';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';

export const VIKUNJA_CALLBACK_PATH = '/api/auth/vikunja/callback';
export const VIKUNJA_LOGIN_TTL_MS = 10 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

export type VikunjaAuthErrorCode =
  | 'disabled'
  | 'access_denied'
  | 'state_mismatch'
  | 'token_exchange_failed'
  | 'userinfo_failed'
  | 'no_email'
  | 'email_not_allowed'
  | 'signup_disabled'
  | 'user_disabled';

export class VikunjaAuthError extends Error {
  constructor(
    public readonly code: VikunjaAuthErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'VikunjaAuthError';
  }
}

// Kept server-side only: encrypted into an httpOnly cookie scoped to the callback path.
export type VikunjaLoginState = {
  state: string;
  verifier: string;
  returnPath: string | null;
  exp: number;
};

export type VikunjaUser = {
  id: number;
  username: string;
  name?: string;
  email?: string;
};

export function base64UrlRandom(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// Same-origin relative paths only, so the post-login redirect can't leave Docmost.
export function safeReturnPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > 2048) return null;
  if (/[\s\\]|\p{C}/u.test(input)) return null;
  if (!input.startsWith('/') || input.startsWith('//')) return null;
  if (input.toLowerCase().includes('://')) return null;
  if (input.startsWith('/api/')) return null;
  return input;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

@Injectable()
export class VikunjaAuthService {
  private readonly logger = new Logger(VikunjaAuthService.name);

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly encryptionService: EncryptionService,
    private readonly sessionService: SessionService,
    private readonly signupService: SignupService,
    private readonly userRepo: UserRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  isEnabled(): boolean {
    return this.environmentService.isVikunjaAuthEnabled();
  }

  getRedirectUri(): string {
    const appUrl = this.environmentService.getAppUrl().replace(/\/+$/, '');
    return `${appUrl}${VIKUNJA_CALLBACK_PATH}`;
  }

  /**
   * Starts a login: returns the Vikunja authorize URL and the encrypted
   * state cookie that must come back with the callback.
   */
  createLoginRequest(returnPath?: unknown): {
    authorizeUrl: string;
    stateCookie: string;
  } {
    if (!this.isEnabled()) throw new VikunjaAuthError('disabled');

    const loginState: VikunjaLoginState = {
      state: base64UrlRandom(32),
      verifier: base64UrlRandom(48),
      returnPath: safeReturnPath(returnPath),
      exp: Date.now() + VIKUNJA_LOGIN_TTL_MS,
    };

    const url = new URL(
      `${this.environmentService.getVikunjaAuthUrl()}/oauth/authorize`,
    );
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'client_id',
      this.environmentService.getVikunjaAuthClientId(),
    );
    url.searchParams.set('redirect_uri', this.getRedirectUri());
    url.searchParams.set('state', loginState.state);
    url.searchParams.set('code_challenge', pkceChallenge(loginState.verifier));
    url.searchParams.set('code_challenge_method', 'S256');

    return {
      authorizeUrl: url.toString(),
      stateCookie: this.encryptionService.encrypt(
        JSON.stringify(loginState),
        EncryptionPurpose.VIKUNJA_LOGIN,
      ),
    };
  }

  /**
   * Validates the callback against the state cookie, exchanges the code
   * (with the PKCE verifier) and resolves the Docmost user. Identity comes only
   * from Vikunja's API using the server-obtained access token.
   */
  async completeLogin(opts: {
    code: string;
    state: string;
    stateCookie: string | undefined;
    workspace: Workspace;
  }): Promise<{ authToken: string; returnPath: string | null }> {
    if (!this.isEnabled()) throw new VikunjaAuthError('disabled');

    const loginState = this.readLoginState(opts.stateCookie);
    if (
      !loginState ||
      typeof opts.state !== 'string' ||
      !constantTimeEquals(opts.state, loginState.state)
    ) {
      throw new VikunjaAuthError('state_mismatch');
    }

    if (typeof opts.code !== 'string' || opts.code.length === 0) {
      throw new VikunjaAuthError('access_denied');
    }

    const accessToken = await this.exchangeCode(opts.code, loginState.verifier);
    const vikunjaUser = await this.fetchVikunjaUser(accessToken);
    const user = await this.findOrCreateUser(vikunjaUser, opts.workspace);

    await this.userRepo.updateLastLogin(user.id, opts.workspace.id);

    this.auditService.setActorId(user.id);
    this.auditService.log({
      event: AuditEvent.USER_LOGIN,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { source: 'vikunja', vikunjaUserId: vikunjaUser.id },
    });

    const authToken = await this.sessionService.createSessionAndToken(user);
    return { authToken, returnPath: loginState.returnPath };
  }

  private readLoginState(cookie: string | undefined): VikunjaLoginState | null {
    if (!cookie) return null;
    try {
      const parsed = JSON.parse(
        this.encryptionService.decrypt(cookie, EncryptionPurpose.VIKUNJA_LOGIN),
      ) as VikunjaLoginState;
      if (
        typeof parsed?.state !== 'string' ||
        typeof parsed?.verifier !== 'string' ||
        typeof parsed?.exp !== 'number' ||
        parsed.exp < Date.now()
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async exchangeCode(code: string, verifier: string): Promise<string> {
    const tokenUrl = `${this.environmentService.getVikunjaAuthInternalUrl()}/api/v1/oauth/token`;
    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: this.environmentService.getVikunjaAuthClientId(),
          redirect_uri: this.getRedirectUri(),
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      this.logger.warn(
        `Vikunja token request failed: ${(err as Error).message}`,
      );
      throw new VikunjaAuthError('token_exchange_failed');
    }

    if (!response.ok) {
      this.logger.warn(`Vikunja token endpoint returned ${response.status}`);
      throw new VikunjaAuthError('token_exchange_failed');
    }

    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
    } | null;
    if (typeof body?.access_token !== 'string' || !body.access_token) {
      throw new VikunjaAuthError('token_exchange_failed');
    }
    return body.access_token;
  }

  async fetchVikunjaUser(accessToken: string): Promise<VikunjaUser> {
    const userUrl = `${this.environmentService.getVikunjaAuthInternalUrl()}/api/v2/user`;
    let response: Response;
    try {
      response = await fetch(userUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      this.logger.warn(
        `Vikunja user request failed: ${(err as Error).message}`,
      );
      throw new VikunjaAuthError('userinfo_failed');
    }

    if (!response.ok) {
      this.logger.warn(`Vikunja user endpoint returned ${response.status}`);
      throw new VikunjaAuthError('userinfo_failed');
    }

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body.id !== 'number' || body.id <= 0) {
      throw new VikunjaAuthError('userinfo_failed');
    }

    return {
      id: body.id,
      username: typeof body.username === 'string' ? body.username : '',
      name: typeof body.name === 'string' ? body.name : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
    };
  }

  async findOrCreateUser(
    vikunjaUser: VikunjaUser,
    workspace: Workspace,
  ): Promise<User> {
    const email = vikunjaUser.email?.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      throw new VikunjaAuthError('no_email');
    }

    const existing = await this.userRepo.findByEmail(email, workspace.id);
    if (existing) {
      if (isUserDisabled(existing)) {
        throw new VikunjaAuthError('user_disabled');
      }
      return existing;
    }

    if (!this.environmentService.isVikunjaAuthSignupAllowed()) {
      throw new VikunjaAuthError('signup_disabled');
    }

    try {
      validateAllowedEmail(email, workspace);
    } catch {
      throw new VikunjaAuthError('email_not_allowed');
    }

    const name = (
      vikunjaUser.name ||
      vikunjaUser.username ||
      email.split('@')[0]
    )
      .trim()
      .slice(0, 50);

    // Random password nobody knows: the account signs in through Vikunja (a password
    // reset still works if password login stays enabled and mail is configured).
    return executeTx(this.db, async (trx) => {
      const user = await this.signupService.signup(
        { name, email, password: base64UrlRandom(32) },
        workspace.id,
        trx,
      );
      await this.userRepo.updateUser(
        { hasGeneratedPassword: true, emailVerifiedAt: new Date() },
        user.id,
        workspace.id,
        trx,
      );
      this.logger.log(
        `Created Docmost user ${user.id} from Vikunja user ${vikunjaUser.id}`,
      );
      return user;
    });
  }
}
