import { Equals, IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class RegisterCustomerDto {
  @IsString()
  @Length(2, 160)
  fullName!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(/^\+?[\d ()-]{9,18}$/)
  phone!: string;

  @IsString()
  @Matches(/^[\d -]{7,14}$/)
  nationalId!: string;

  @IsString()
  @Length(12, 72)
  password!: string;

  @IsString()
  @Length(12, 72)
  confirmPassword!: string;

  @Equals(true)
  termsAccepted!: boolean;

  @Equals(true)
  privacyAccepted!: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^[A-F0-9]{16}$/)
  referralCode?: string;
}

export class CustomerLoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(1, 72)
  password!: string;
}

export class PasswordResetRequestDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class PasswordResetCompleteDto {
  @IsString()
  @Length(32, 128)
  token!: string;

  @IsString()
  @Length(12, 72)
  password!: string;

  @IsString()
  @Length(12, 72)
  confirmPassword!: string;
}

export class PasswordChangeDto {
  @IsString()
  @Length(1, 72)
  currentPassword!: string;

  @IsString()
  @Length(12, 72)
  password!: string;

  @IsString()
  @Length(12, 72)
  confirmPassword!: string;
}

export class SuperadminPasswordDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Length(1, 72)
  password!: string;
}

export class SuperadminOtpDto {
  @IsString()
  @Length(20, 40)
  challengeId!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}