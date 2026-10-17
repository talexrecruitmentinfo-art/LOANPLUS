import { IsEnum, IsString, Length } from 'class-validator';
import { SupportTicketStatus } from '@prisma/client';

export class CreateSupportTicketDto {
  @IsString()
  @Length(4, 160)
  subject!: string;

  @IsString()
  @Length(10, 4000)
  message!: string;
}

export class ReplySupportTicketDto {
  @IsString()
  @Length(2, 4000)
  message!: string;

  @IsEnum(SupportTicketStatus)
  status!: SupportTicketStatus;
}