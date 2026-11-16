import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApiTokenService } from './api-token.service';
import { ApiTokenRepo } from './api-token.repo';
import { TokenService } from '../auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { JwtApiKeyPayload, JwtType } from '../auth/dto/jwt-payload';

describe('ApiTokenService', () => {
  let service: ApiTokenService;
  let repo: Record<string, jest.Mock>;
  let userRepo: Record<string, jest.Mock>;
  let workspaceRepo: Record<string, jest.Mock>;
  let tokenService: Record<string, jest.Mock>;

  const workspaceId = '00000000-0000-0000-0000-0000000000aa';
  const userId = '00000000-0000-0000-0000-0000000000bb';
  const apiKeyId = '00000000-0000-0000-0000-0000000000cc';

  const payload: JwtApiKeyPayload = {
    sub: userId,
    workspaceId,
    apiKeyId,
    type: JwtType.API_KEY as 'api_key',
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: apiKeyId,
    name: 'laptop',
    creatorId: userId,
    workspaceId,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  });
  const member = { id: userId, role: 'member', deactivatedAt: null, deletedAt: null };
  const workspace = (restrictToAdmins = false) => ({
    id: workspaceId,
    settings: { api: { restrictToAdmins } },
  });

  beforeEach(async () => {
    repo = {
      insert: jest.fn(),
      findActiveById: jest.fn(),
      listByCreator: jest.fn(),
      revoke: jest.fn(),
      touchLastUsed: jest.fn().mockResolvedValue(undefined),
    };
    userRepo = { findById: jest.fn().mockResolvedValue(member) };
    workspaceRepo = { findById: jest.fn().mockResolvedValue(workspace()) };
    tokenService = { generateApiToken: jest.fn().mockResolvedValue('jwt') };

    const module = await Test.createTestingModule({
      providers: [
        ApiTokenService,
        { provide: ApiTokenRepo, useValue: repo },
        { provide: TokenService, useValue: tokenService },
        { provide: UserRepo, useValue: userRepo },
        { provide: WorkspaceRepo, useValue: workspaceRepo },
      ],
    }).compile();

    service = module.get(ApiTokenService);
  });

  describe('validateApiKey', () => {
    it('accepts an active token and records usage', async () => {
      repo.findActiveById.mockResolvedValue(row());
      const result = await service.validateApiKey(payload);
      expect(result.user).toBe(member);
      expect(repo.touchLastUsed).toHaveBeenCalledWith(apiKeyId);
    });

    it('does not touch lastUsedAt again within the throttle window', async () => {
      repo.findActiveById.mockResolvedValue(row({ lastUsedAt: new Date() }));
      await service.validateApiKey(payload);
      expect(repo.touchLastUsed).not.toHaveBeenCalled();
    });

    it('rejects a revoked (missing) token', async () => {
      repo.findActiveById.mockResolvedValue(undefined);
      await expect(service.validateApiKey(payload)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an expired token', async () => {
      repo.findActiveById.mockResolvedValue(
        row({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.validateApiKey(payload)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token from another workspace or user', async () => {
      repo.findActiveById.mockResolvedValue(row({ workspaceId: 'other' }));
      await expect(service.validateApiKey(payload)).rejects.toThrow(
        UnauthorizedException,
      );
      repo.findActiveById.mockResolvedValue(row({ creatorId: 'other' }));
      await expect(service.validateApiKey(payload)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a deactivated user', async () => {
      repo.findActiveById.mockResolvedValue(row());
      userRepo.findById.mockResolvedValue({ ...member, deactivatedAt: new Date() });
      await expect(service.validateApiKey(payload)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects members when API access is restricted to admins', async () => {
      repo.findActiveById.mockResolvedValue(row());
      workspaceRepo.findById.mockResolvedValue(workspace(true));
      await expect(service.validateApiKey(payload)).rejects.toThrow(
        UnauthorizedException,
      );
      userRepo.findById.mockResolvedValue({ ...member, role: 'admin' });
      await expect(service.validateApiKey(payload)).resolves.toBeDefined();
    });
  });

  describe('create', () => {
    it('returns the token once and signs with the row id', async () => {
      repo.insert.mockResolvedValue(row());
      const result = await service.create(member as any, workspace() as any, 'laptop');
      expect(result.token).toBe('jwt');
      expect(tokenService.generateApiToken).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyId, workspaceId }),
      );
    });

    it('refuses members when API access is restricted to admins', async () => {
      await expect(
        service.create(member as any, workspace(true) as any, 'laptop'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('revoke', () => {
    it('lets the owner revoke but not another member', async () => {
      repo.findActiveById.mockResolvedValue(row());
      await service.revoke(apiKeyId, member as any, workspace() as any);
      expect(repo.revoke).toHaveBeenCalledWith(apiKeyId);

      const other = { ...member, id: 'someone-else' };
      await expect(
        service.revoke(apiKeyId, other as any, workspace() as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets a workspace admin revoke any token', async () => {
      repo.findActiveById.mockResolvedValue(row());
      const admin = { ...member, id: 'admin', role: 'admin' };
      await service.revoke(apiKeyId, admin as any, workspace() as any);
      expect(repo.revoke).toHaveBeenCalledWith(apiKeyId);
    });
  });
});
