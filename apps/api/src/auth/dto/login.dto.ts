import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Login must not enforce the new password policy — existing users may have
  // legacy passwords. Only presence and a sane upper bound are validated here.
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
