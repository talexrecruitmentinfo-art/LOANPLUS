import { PartialType } from '@nestjs/swagger';
import { Equals, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

export class CreateLoanProductDto {
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsString()
  @Length(10, 1000)
  description!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  minimumPrincipalKes!: number;

  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  maximumPrincipalKes!: number;

  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays!: number;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  interestRateBps!: number;

  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  flatFeeKes!: number;

  @IsString()
  @Length(1, 40)
  termsVersion!: string;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsObject()
  eligibilityRules?: Record<string, unknown>;
}

export class UpdateLoanProductDto extends PartialType(CreateLoanProductDto) {}

export class ReviewLoanApplicationDto {
  @IsIn(['APPROVE', 'REJECT', 'REQUEST_INFORMATION'])
  decision!: 'APPROVE' | 'REJECT' | 'REQUEST_INFORMATION';

  @IsString()
  @Length(10, 1000)
  reason!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  approvedPrincipalKes?: number;
}

export class AcceptLoanOfferDto {
  @Equals(true)
  termsAccepted!: boolean;
}

export class CreateLoanApplicationDto {
  @IsString()
  @Length(1, 40)
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  requestedPrincipalKes!: number;

  @IsString()
  @Length(2, 160)
  guarantorOneName!: string;

  @IsString()
  @Length(9, 16)
  @Matches(/^\+?[\d ()-]{9,16}$/)
  guarantorOnePhone!: string;

  @IsString()
  @Length(2, 160)
  guarantorTwoName!: string;

  @IsString()
  @Length(9, 16)
  @Matches(/^\+?[\d ()-]{9,16}$/)
  guarantorTwoPhone!: string;
}

export class ConfigureLoanProcessingFeeDto {
  @IsString()
  @Length(3, 40)
  @Matches(/^[A-Z][A-Z0-9_]{2,39}$/)
  revenueAccountCode!: string;

  @IsString()
  @Length(10, 500)
  reason!: string;
}

export class ConfirmManualDisbursementDto {
  @IsString()
  @Length(6, 100)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  paymentReference!: string;

  @IsString()
  @Length(10, 500)
  reason!: string;
}