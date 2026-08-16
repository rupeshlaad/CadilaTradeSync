import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsStrongPassword } from '../password-policy';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsStrongPassword()
  password!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;
}
