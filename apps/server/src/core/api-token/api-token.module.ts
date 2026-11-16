import { Module } from '@nestjs/common';
import { TokenModule } from '../auth/token.module';
import { ApiTokenController } from './api-token.controller';
import { ApiTokenRepo } from './api-token.repo';
import { ApiTokenService } from './api-token.service';

@Module({
  imports: [TokenModule],
  controllers: [ApiTokenController],
  providers: [ApiTokenRepo, ApiTokenService],
  exports: [ApiTokenService],
})
export class ApiTokenModule {}
