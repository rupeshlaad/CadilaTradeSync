import { Global, Module } from '@nestjs/common';
import { EncryptionService, PlaceholderEncryptionService } from './encryption.service';

@Global()
@Module({
  providers: [{ provide: EncryptionService, useClass: PlaceholderEncryptionService }],
  exports: [EncryptionService],
})
export class EncryptionModule {}
