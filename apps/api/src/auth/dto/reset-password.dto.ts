import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../password-policy';

export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;

  @IsStrongPassword()
  password!: string;
}
