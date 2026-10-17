import { Equals, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

export class ConfigureActivationDto {
  @IsInt()
  @Equals(50)
  @Min(1)
  @Max(100_000)
  amountKes!: number;

  @IsBoolean()
  approved!: boolean;

  @IsString()
  @Length(10, 500)
  purpose!: string;

  @IsIn(['REFUNDABLE', 'NON_REFUNDABLE', 'CONDITIONAL_REFUND'])
  refundability!: 'REFUNDABLE' | 'NON_REFUNDABLE' | 'CONDITIONAL_REFUND';

  @IsBoolean()
  creditedToWallet!: boolean;

  @IsString()
  @Length(10, 500)
  accountingTreatment!: string;

  @IsString()
  @Length(20, 2000)
  customerDisclosure!: string;

  @IsString()
  @Length(1, 40)
  termsVersion!: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  creditAccountCode?: string;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

export class InitiateActivationPaymentDto {
  @IsString()
  @Length(9, 16)
  @Matches(/^\+?[\d ()-]{9,16}$/)
  phoneNumber!: string;

  @Equals(true)
  termsAccepted!: boolean;

  @IsString()
  @Length(1, 40)
  termsVersion!: string;
}