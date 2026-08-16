import { IsString, MinLength } from 'class-validator';
import { IsStrongPassword } from '../password-policy';

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsStrongPassword()
  newPassword!: string;
}
