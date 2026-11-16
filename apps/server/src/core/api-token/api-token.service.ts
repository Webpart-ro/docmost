import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTokenRepo, ApiTokenSummary } from './api-token.repo';
import { TokenService } from '../auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { JwtApiKeyPayload } from '../auth/dto/jwt-payload';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { isUserDisabled } from '../../common/helpers';
import { UserRole } from '../../common/helpers/types/permission';

const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;
// JwtModule signs with a default expiry, so "never expires" means a long one.
const NO_EXPIRY_SECONDS = 10 * 365 * 24 * 60 * 60;

export function isWorkspaceAdmin(user: Pick<User, 'role'>): boolean {
  return user.role === UserRole.OWNER || user.role === UserRole.ADMIN;
}

export function isApiRestrictedToAdmins(workspace: Workspace): boolean {
  const settings = (workspace?.settings ?? {}) as {
    api?: { restrictToAdmins?: boolean };
  };
  return settings.api?.restrictToAdmins === true;
}

@Injectable()
export class ApiTokenService {
  private readonly logger = new Logger(ApiTokenService.name);

  constructor(
    private readonly apiTokenRepo: ApiTokenRepo,
    private readonly tokenService: TokenService,
    private readonly userRepo: UserRepo,
    private readonly workspaceRepo: WorkspaceRepo,
  ) {}

  async create(
    user: User,
    workspace: Workspace,
    name: string,
    expiresAt?: Date,
  ): Promise<ApiTokenSummary & { token: string }> {
    this.assertMayUseApi(user, workspace);

    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new ForbiddenException('Expiry date must be in the future');
    }

    const row = await this.apiTokenRepo.insert({
      name,
      creatorId: user.id,
      workspaceId: workspace.id,
      expiresAt: expiresAt ?? null,
    });

    const expiresIn = expiresAt
      ? Math.ceil((expiresAt.getTime() - Date.now()) / 1000)
      : NO_EXPIRY_SECONDS;

    const token = await this.tokenService.generateApiToken({
      apiKeyId: row.id,
      user,
      workspaceId: workspace.id,
      expiresIn,
    });

    return {
      id: row.id,
      name: row.name,
      creatorId: row.creatorId,
      workspaceId: row.workspaceId,
      expiresAt: row.expiresAt,
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
      token,
    };
  }

  async list(user: User, workspace: Workspace): Promise<ApiTokenSummary[]> {
    return this.apiTokenRepo.listByCreator(user.id, workspace.id);
  }

  async revoke(id: string, user: User, workspace: Workspace): Promise<void> {
    const row = await this.apiTokenRepo.findActiveById(id);
    if (!row || row.workspaceId !== workspace.id) {
      throw new NotFoundException('API token not found');
    }
    if (row.creatorId !== user.id && !isWorkspaceAdmin(user)) {
      throw new ForbiddenException();
    }
    await this.apiTokenRepo.revoke(id);
  }

  /**
   * Called by JwtStrategy for `type: api_key` JWTs. The JWT signature and
   * expiry are already verified; this checks the revocation row and the user.
   */
  async validateApiKey(
    payload: JwtApiKeyPayload,
  ): Promise<{ user: User; workspace: Workspace }> {
    const row = await this.apiTokenRepo.findActiveById(payload.apiKeyId);
    if (
      !row ||
      row.creatorId !== payload.sub ||
      row.workspaceId !== payload.workspaceId
    ) {
      throw new UnauthorizedException();
    }

    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
      throw new UnauthorizedException();
    }

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) {
      throw new UnauthorizedException();
    }

    const user = await this.userRepo.findById(payload.sub, payload.workspaceId);
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    if (isApiRestrictedToAdmins(workspace) && !isWorkspaceAdmin(user)) {
      throw new UnauthorizedException();
    }

    const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
      this.apiTokenRepo
        .touchLastUsed(row.id)
        .catch((err) =>
          this.logger.warn(`failed to update lastUsedAt: ${err?.message}`),
        );
    }

    return { user, workspace };
  }

  private assertMayUseApi(user: User, workspace: Workspace) {
    if (isApiRestrictedToAdmins(workspace) && !isWorkspaceAdmin(user)) {
      throw new ForbiddenException(
        'API access is restricted to workspace admins',
      );
    }
  }
}
