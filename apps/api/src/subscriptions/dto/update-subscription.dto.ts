import { IsDateString, IsEnum, IsOptional } from 'class-validator';
import { SubscriptionStatus } from '@prisma/client';

export class UpdateSubscriptionDto {
  @IsOptional() @IsEnum(SubscriptionStatus) status?: SubscriptionStatus;
  @IsOptional() @IsDateString() endDate?: string;
}
