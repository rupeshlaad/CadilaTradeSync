import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  // Login must not enforce the new password policy — existing users may have
  // legacy passwords. Only presence is validated here.
  @IsString()
  @MinLength(1)
  password!: string;
}
