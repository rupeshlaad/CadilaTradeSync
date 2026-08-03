-- Add EXPIRED value to ConnectionStatus enum (used to represent an expired broker session token)
ALTER TYPE "ConnectionStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
