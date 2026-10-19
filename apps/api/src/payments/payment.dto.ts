import { Equals, IsString, Length, Matches } from 'class-validator';

export class InitiateLoanProcessingFeeDto {
  @IsString()
  @Length(1, 40)
  applicationId!: string;

  @Equals(true)
  reviewConfirmed!: true;

  @IsString()
  @Length(9, 16)
  @Matches(/^\+?[\d ()-]{9,16}$/)
  mpesaPhoneNumber!: string;
}