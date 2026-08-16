import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AcceptTermsDto {
  /** Optional explicit version; defaults to the server's current TERMS_VERSION. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  version?: string;
}
