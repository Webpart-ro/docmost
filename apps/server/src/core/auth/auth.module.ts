import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SignupService } from './services/signup.service';
import { TokenModule } from './token.module';
import { VikunjaAuthController } from './vikunja/vikunja-auth.controller';
import { VikunjaAuthService } from './vikunja/vikunja-auth.service';

@Module({
  imports: [TokenModule, WorkspaceModule],
  controllers: [AuthController, VikunjaAuthController],
  providers: [AuthService, SignupService, JwtStrategy, VikunjaAuthService],
  exports: [SignupService],
})
export class AuthModule {}
