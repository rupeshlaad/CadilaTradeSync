import { IsString, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../password-policy';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @IsStrongPassword()
  newPassword!: string;
}
