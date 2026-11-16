import { Module } from '@nestjs/common';
import { TokenModule } from '../auth/token.module';
import { ApiTokenModule } from '../api-token/api-token.module';
import { McpController } from './mcp.controller';

@Module({
  imports: [TokenModule, ApiTokenModule],
  controllers: [McpController],
})
export class McpModule {}
