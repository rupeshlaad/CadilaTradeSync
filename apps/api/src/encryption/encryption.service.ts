import { Injectable } from '@nestjs/common';

/**
 * Contract for credential encryption.
 *
 * PRODUCTION IMPLEMENTATION MUST:
 *  - Use authenticated encryption (AES-256-GCM or ChaCha20-Poly1305)
 *  - Use a KMS-backed data-encryption-key (AWS KMS / GCP KMS / Vault Transit)
 *  - Use per-record random IV + additional authenticated data
 *  - Support key rotation via versioned key material
 */
export abstract class EncryptionService {
  abstract encrypt(plain: string): string;
  abstract decrypt(cipher: string): string;
}

/**
 * Placeholder implementation — base64 with a version tag.
 *
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * !!! DO NOT USE IN PRODUCTION. NOT CRYPTOGRAPHICALLY SECURE. !!!
 * !!! Replace with EnvelopeAesGcmEncryptionService backed by KMS.
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */
@Injectable()
export class PlaceholderEncryptionService extends EncryptionService {
  private readonly prefix = 'enc.v0.';

  encrypt(plain: string): string {
    if (plain == null || plain === '') return '';
    return this.prefix + Buffer.from(plain, 'utf8').toString('base64');
  }

  decrypt(cipher: string): string {
    if (!cipher) return '';
    if (!cipher.startsWith(this.prefix)) return cipher;
    return Buffer.from(cipher.slice(this.prefix.length), 'base64').toString('utf8');
  }
}
