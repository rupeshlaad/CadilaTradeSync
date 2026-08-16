import { registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator';

/**
 * Sprint 1 — Centralized production password policy.
 *
 * ONE source of truth shared by registration, password reset and change
 * password so the rules never diverge. Deliberately sensible (not
 * over-engineered): a reasonable minimum length plus at least one letter and
 * one digit. No forced special-character/rotation rules that hurt usability.
 */
export const PASSWORD_POLICY = {
  minLength: 8,
  maxLength: 128,
  description:
    'Password must be at least 8 characters and include at least one letter and one number.',
};

export function validatePassword(password: unknown): string[] {
  const errors: string[] = [];
  if (typeof password !== 'string' || password.length === 0) {
    return ['Password is required.'];
  }
  if (password.length < PASSWORD_POLICY.minLength) {
    errors.push(`Password must be at least ${PASSWORD_POLICY.minLength} characters.`);
  }
  if (password.length > PASSWORD_POLICY.maxLength) {
    errors.push(`Password must be at most ${PASSWORD_POLICY.maxLength} characters.`);
  }
  if (!/[A-Za-z]/.test(password)) {
    errors.push('Password must include at least one letter.');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must include at least one number.');
  }
  return errors;
}

export function isPasswordValid(password: unknown): boolean {
  return validatePassword(password).length === 0;
}

/**
 * class-validator decorator wrapping the shared policy so DTOs stay declarative
 * and consistent with the rest of the codebase.
 */
export function IsStrongPassword(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isPasswordValid(value);
        },
        defaultMessage(args: ValidationArguments) {
          const errs = validatePassword(args.value);
          return errs[0] ?? PASSWORD_POLICY.description;
        },
      },
    });
  };
}
