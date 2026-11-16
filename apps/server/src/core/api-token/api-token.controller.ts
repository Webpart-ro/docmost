import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { ApiTokenService } from './api-token.service';
import { ApiTokenIdDto, CreateApiTokenDto } from './dto/api-token.dto';

// Session-only: an API token must never be able to mint or revoke tokens.
@UseGuards(JwtAuthGuard)
@RequireSessionAuth()
@Controller('api-tokens')
export class ApiTokenController {
  constructor(private readonly apiTokenService: ApiTokenService) {}

  @HttpCode(HttpStatus.OK)
  @Post('/')
  async list(@AuthUser() user: User, @AuthWorkspace() workspace: Workspace) {
    return this.apiTokenService.list(user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async create(
    @Body() dto: CreateApiTokenDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.apiTokenService.create(
      user,
      workspace,
      dto.name,
      dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revoke(
    @Body() dto: ApiTokenIdDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    await this.apiTokenService.revoke(dto.apiTokenId, user, workspace);
  }
}
