import { Equals, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

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

export class WalletDepositDto {
  @IsInt()
  @Min(1)
  amountKes!: number;

  @IsOptional()
  @Equals(true)
  acknowledgePendingDepositRisk?: true;

  @IsString()
  @Length(9, 16)
  @Matches(/^\+?[\d ()-]{9,16}$/)
  mpesaPhoneNumber!: string;
}

export class WalletRepaymentDto {
  @IsInt()
  @Min(1)
  amountKes!: number;

  @Equals(true)
  confirmed!: true;
}