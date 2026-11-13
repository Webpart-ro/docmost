import { Workspace } from '@docmost/db/types/entity.types';
import { EncryptionService } from '../../../integrations/encryption/encryption.service';
import {
  pkceChallenge,
  safeReturnPath,
  VikunjaAuthError,
  VikunjaAuthService,
} from './vikunja-auth.service';

const workspace = { id: 'workspace-1', emailDomains: [] } as Workspace;

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    getAppSecret: () => 'test-secret-that-is-long-enough-for-hkdf-000',
    getAppUrl: () => 'https://n.example.ro',
    getVikunjaAuthUrl: () => 'https://tasks.example.ro',
    getVikunjaAuthInternalUrl: () => 'http://vikunja:3456',
    getVikunjaAuthClientId: () => 'docmost',
    isVikunjaAuthEnabled: () => true,
    isVikunjaAuthSignupAllowed: () => true,
    ...overrides,
  } as any;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function build(envOverrides: Record<string, unknown> = {}) {
  const env = makeEnv(envOverrides);
  const encryptionService = new EncryptionService(env);
  const sessionService = {
    createSessionAndToken: jest.fn().mockResolvedValue('session-jwt'),
  };
  const signupService = {
    signup: jest.fn().mockImplementation(async (dto) => ({
      id: 'new-user',
      workspaceId: workspace.id,
      email: dto.email,
      name: dto.name,
    })),
  };
  const userRepo = {
    findByEmail: jest.fn().mockResolvedValue(undefined),
    updateUser: jest.fn().mockResolvedValue(undefined),
    updateLastLogin: jest.fn().mockResolvedValue(undefined),
  };
  // executeTx() calls db.transaction().execute(fn)
  const db = {
    transaction: () => ({ execute: (fn: any) => fn('trx') }),
  };
  const auditService = { log: jest.fn(), setActorId: jest.fn() };

  const service = new VikunjaAuthService(
    env,
    encryptionService,
    sessionService as any,
    signupService as any,
    userRepo as any,
    db as any,
    auditService as any,
  );

  return {
    service,
    sessionService,
    signupService,
    userRepo,
    auditService,
  };
}

function startLogin(service: VikunjaAuthService, redirect?: string) {
  const { authorizeUrl, stateCookie } = service.createLoginRequest(redirect);
  const url = new URL(authorizeUrl);
  return { url, stateCookie, state: url.searchParams.get('state') };
}

const vikunjaUser = {
  id: 42,
  username: 'ana',
  name: 'Ana Pop',
  email: 'Ana@Webpart.ro',
  settings: {},
  is_local_user: true,
};

describe('VikunjaAuthService', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe('createLoginRequest', () => {
    it('builds an S256 PKCE authorize URL against the public Vikunja URL', () => {
      const { service } = build();
      const { url, stateCookie } = startLogin(service);

      expect(url.origin + url.pathname).toBe(
        'https://tasks.example.ro/oauth/authorize',
      );
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('docmost');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://n.example.ro/api/auth/vikunja/callback',
      );
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toMatch(/^[\w-]{43}$/);
      // verifier never leaves the server in clear text
      expect(stateCookie).not.toContain(url.searchParams.get('state'));
    });

    it('refuses when Vikunja login is not configured', () => {
      const { service } = build({ isVikunjaAuthEnabled: () => false });
      expect(() => service.createLoginRequest()).toThrow(VikunjaAuthError);
    });
  });

  describe('completeLogin', () => {
    it('rejects a state that does not match the cookie', async () => {
      const { service } = build();
      const { stateCookie } = startLogin(service);

      await expect(
        service.completeLogin({
          code: 'code-1',
          state: 'attacker-state',
          stateCookie,
          workspace,
        }),
      ).rejects.toMatchObject({ code: 'state_mismatch' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a callback without the state cookie', async () => {
      const { service } = build();
      const { state } = startLogin(service);

      await expect(
        service.completeLogin({
          code: 'code-1',
          state,
          stateCookie: undefined,
          workspace,
        }),
      ).rejects.toMatchObject({ code: 'state_mismatch' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a tampered state cookie', async () => {
      const { service } = build();
      const { state, stateCookie } = startLogin(service);

      await expect(
        service.completeLogin({
          code: 'code-1',
          state,
          stateCookie: stateCookie.slice(0, -4) + 'AAAA',
          workspace,
        }),
      ).rejects.toMatchObject({ code: 'state_mismatch' });
    });

    it('handles a failed token exchange without creating a session', async () => {
      const { service, sessionService, signupService } = build();
      const { state, stateCookie } = startLogin(service);
      fetchMock.mockResolvedValueOnce(
        jsonResponse(400, { message: 'invalid_grant' }),
      );

      await expect(
        service.completeLogin({ code: 'bad', state, stateCookie, workspace }),
      ).rejects.toMatchObject({ code: 'token_exchange_failed' });
      expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
      expect(signupService.signup).not.toHaveBeenCalled();
    });

    it('handles a network error during the token exchange', async () => {
      const { service } = build();
      const { state, stateCookie } = startLogin(service);
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(
        service.completeLogin({ code: 'c', state, stateCookie, workspace }),
      ).rejects.toMatchObject({ code: 'token_exchange_failed' });
    });

    it('sends the PKCE verifier and identifies the user with the access token', async () => {
      const { service } = build();
      const { url, state, stateCookie } = startLogin(service);
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            access_token: 'vk-access',
            refresh_token: 'vk-refresh',
            expires_in: 3600,
          }),
        )
        .mockResolvedValueOnce(jsonResponse(200, vikunjaUser));

      await service.completeLogin({
        code: 'code-1',
        state,
        stateCookie,
        workspace,
      });

      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe('http://vikunja:3456/api/v1/oauth/token');
      const tokenBody = JSON.parse(tokenInit.body);
      expect(tokenBody).toMatchObject({
        grant_type: 'authorization_code',
        code: 'code-1',
        client_id: 'docmost',
        redirect_uri: 'https://n.example.ro/api/auth/vikunja/callback',
      });
      expect(pkceChallenge(tokenBody.code_verifier)).toBe(
        url.searchParams.get('code_challenge'),
      );

      const [userUrl, userInit] = fetchMock.mock.calls[1];
      expect(userUrl).toBe('http://vikunja:3456/api/v2/user');
      expect(userInit.headers.Authorization).toBe('Bearer vk-access');
    });

    it('creates a new member user when no Docmost account has the email', async () => {
      const { service, signupService, userRepo, sessionService } = build();
      const { state, stateCookie } = startLogin(service, '/s/general');
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { access_token: 'vk' }))
        .mockResolvedValueOnce(jsonResponse(200, vikunjaUser));

      const result = await service.completeLogin({
        code: 'code-1',
        state,
        stateCookie,
        workspace,
      });

      expect(userRepo.findByEmail).toHaveBeenCalledWith(
        'ana@webpart.ro',
        workspace.id,
      );
      // role is left to SignupService -> workspace.defaultRole (member)
      expect(signupService.signup).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Ana Pop', email: 'ana@webpart.ro' }),
        workspace.id,
        'trx',
      );
      expect(signupService.signup.mock.calls[0][0]).not.toHaveProperty('role');
      expect(userRepo.updateUser).toHaveBeenCalledWith(
        expect.objectContaining({ hasGeneratedPassword: true }),
        'new-user',
        workspace.id,
        'trx',
      );
      expect(sessionService.createSessionAndToken).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'new-user' }),
      );
      expect(result).toEqual({
        authToken: 'session-jwt',
        returnPath: '/s/general',
      });
    });

    it('links an existing Docmost user by email instead of creating one', async () => {
      const { service, signupService, userRepo, sessionService, auditService } =
        build();
      const existing = {
        id: 'user-7',
        workspaceId: workspace.id,
        email: 'ana@webpart.ro',
        deactivatedAt: null,
        deletedAt: null,
      };
      userRepo.findByEmail.mockResolvedValueOnce(existing);
      const { state, stateCookie } = startLogin(service);
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { access_token: 'vk' }))
        .mockResolvedValueOnce(jsonResponse(200, vikunjaUser));

      const result = await service.completeLogin({
        code: 'code-1',
        state,
        stateCookie,
        workspace,
      });

      expect(signupService.signup).not.toHaveBeenCalled();
      expect(userRepo.updateLastLogin).toHaveBeenCalledWith(
        'user-7',
        workspace.id,
      );
      expect(sessionService.createSessionAndToken).toHaveBeenCalledWith(
        existing,
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'user-7',
          metadata: expect.objectContaining({ source: 'vikunja' }),
        }),
      );
      expect(result.authToken).toBe('session-jwt');
      expect(result.returnPath).toBeNull();
    });

    it('refuses a deactivated Docmost user', async () => {
      const { service, sessionService, userRepo } = build();
      userRepo.findByEmail.mockResolvedValueOnce({
        id: 'user-7',
        deactivatedAt: new Date(),
      });
      const { state, stateCookie } = startLogin(service);
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { access_token: 'vk' }))
        .mockResolvedValueOnce(jsonResponse(200, vikunjaUser));

      await expect(
        service.completeLogin({ code: 'c', state, stateCookie, workspace }),
      ).rejects.toMatchObject({ code: 'user_disabled' });
      expect(sessionService.createSessionAndToken).not.toHaveBeenCalled();
    });

    it('does not auto-create users when signup is disabled', async () => {
      const { service, signupService } = build({
        isVikunjaAuthSignupAllowed: () => false,
      });
      const { state, stateCookie } = startLogin(service);
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { access_token: 'vk' }))
        .mockResolvedValueOnce(jsonResponse(200, vikunjaUser));

      await expect(
        service.completeLogin({ code: 'c', state, stateCookie, workspace }),
      ).rejects.toMatchObject({ code: 'signup_disabled' });
      expect(signupService.signup).not.toHaveBeenCalled();
    });

    it('fails when Vikunja rejects the access token', async () => {
      const { service } = build();
      const { state, stateCookie } = startLogin(service);
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { access_token: 'vk' }))
        .mockResolvedValueOnce(jsonResponse(401, { message: 'invalid token' }));

      await expect(
        service.completeLogin({ code: 'c', state, stateCookie, workspace }),
      ).rejects.toMatchObject({ code: 'userinfo_failed' });
    });

    it('fails when the Vikunja account has no email', async () => {
      const { service } = build();
      const { state, stateCookie } = startLogin(service);
      fetchMock
        .mockResolvedValueOnce(jsonResponse(200, { access_token: 'vk' }))
        .mockResolvedValueOnce(
          jsonResponse(200, { ...vikunjaUser, email: undefined }),
        );

      await expect(
        service.completeLogin({ code: 'c', state, stateCookie, workspace }),
      ).rejects.toMatchObject({ code: 'no_email' });
    });
  });

  describe('safeReturnPath', () => {
    it.each([
      ['/s/general/p/abc', '/s/general/p/abc'],
      ['//evil.example', null],
      ['https://evil.example', null],
      ['/\\evil.example', null],
      ['/api/auth/logout', null],
      ['relative', null],
      [undefined, null],
    ])('%p -> %p', (input, expected) => {
      expect(safeReturnPath(input)).toBe(expected);
    });
  });
});
