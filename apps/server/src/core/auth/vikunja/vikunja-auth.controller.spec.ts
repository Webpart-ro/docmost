import { Logger, NotFoundException } from '@nestjs/common';
import { Workspace } from '@docmost/db/types/entity.types';
import {
  VIKUNJA_STATE_COOKIE,
  VikunjaAuthController,
} from './vikunja-auth.controller';
import { VikunjaAuthError } from './vikunja-auth.service';

const workspace = { id: 'workspace-1' } as Workspace;
const environmentService = {
  isHttps: () => true,
  getCookieExpiresIn: () => new Date('2030-01-01T00:00:00Z'),
} as any;

function reply() {
  return {
    setCookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  } as any;
}

function request(cookie?: string) {
  return { cookies: cookie ? { [VIKUNJA_STATE_COOKIE]: cookie } : {} } as any;
}

function build(service: Record<string, jest.Mock>) {
  return new VikunjaAuthController(service as any, environmentService);
}

describe('VikunjaAuthController', () => {
  describe('login', () => {
    it('sets the encrypted state cookie and redirects to Vikunja', async () => {
      const service = {
        isEnabled: jest.fn().mockReturnValue(true),
        createLoginRequest: jest.fn().mockReturnValue({
          authorizeUrl: 'https://tasks.example.ro/oauth/authorize?x=1',
          stateCookie: 'encrypted',
        }),
      };
      const res = reply();

      await build(service).login(res, '/s/general');

      expect(service.createLoginRequest).toHaveBeenCalledWith('/s/general');
      expect(res.setCookie).toHaveBeenCalledWith(
        VIKUNJA_STATE_COOKIE,
        'encrypted',
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/api/auth/vikunja',
        }),
      );
      expect(res.redirect).toHaveBeenCalledWith(
        'https://tasks.example.ro/oauth/authorize?x=1',
        302,
      );
    });

    it('404s when Vikunja login is not configured', async () => {
      const service = { isEnabled: jest.fn().mockReturnValue(false) };
      await expect(build(service).login(reply())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('callback', () => {
    it('issues the normal authToken cookie and redirects home on success', async () => {
      const service = {
        completeLogin: jest
          .fn()
          .mockResolvedValue({ authToken: 'jwt', returnPath: null }),
      };
      const res = reply();

      await build(service).callback(
        workspace,
        request('encrypted'),
        res,
        'code-1',
        'state-1',
      );

      expect(service.completeLogin).toHaveBeenCalledWith({
        code: 'code-1',
        state: 'state-1',
        stateCookie: 'encrypted',
        workspace,
      });
      expect(res.clearCookie).toHaveBeenCalledWith(VIKUNJA_STATE_COOKIE, {
        path: '/api/auth/vikunja',
      });
      expect(res.setCookie).toHaveBeenCalledWith(
        'authToken',
        'jwt',
        expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
      );
      expect(res.redirect).toHaveBeenCalledWith('/home', 302);
    });

    it('redirects to the saved return path', async () => {
      const service = {
        completeLogin: jest
          .fn()
          .mockResolvedValue({ authToken: 'jwt', returnPath: '/s/general' }),
      };
      const res = reply();
      await build(service).callback(workspace, request('c'), res, 'c', 's');
      expect(res.redirect).toHaveBeenCalledWith('/s/general', 302);
    });

    it('sends a state mismatch back to the login page without a session', async () => {
      const service = {
        completeLogin: jest
          .fn()
          .mockRejectedValue(new VikunjaAuthError('state_mismatch')),
      };
      const res = reply();

      await build(service).callback(workspace, request(), res, 'c', 'forged');

      expect(res.setCookie).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(
        '/login?sso_error=state_mismatch',
        302,
      );
    });

    it('treats a provider error as access denied without calling Vikunja', async () => {
      const service = { completeLogin: jest.fn() };
      const res = reply();

      await build(service).callback(
        workspace,
        request('c'),
        res,
        undefined,
        's',
        'access_denied',
      );

      expect(service.completeLogin).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(
        '/login?sso_error=access_denied',
        302,
      );
    });

    it('does not leak unexpected errors to the browser', async () => {
      const service = {
        completeLogin: jest.fn().mockRejectedValue(new Error('db down')),
      };
      const res = reply();
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      await build(service).callback(workspace, request('c'), res, 'c', 's');

      expect(res.setCookie).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(
        '/login?sso_error=unexpected_error',
        302,
      );
    });
  });
});
