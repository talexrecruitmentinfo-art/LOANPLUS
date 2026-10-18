import { Equals, IsString, Length } from 'class-validator';

export class InitiateLoanProcessingFeeDto {
  @IsString()
  @Length(1, 40)
  applicationId!: string;

  @Equals(true)
  reviewConfirmed!: true;
}