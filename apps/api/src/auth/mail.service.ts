import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  async sendSuperadminOtp(recipient: string, code: string): Promise<void> {
    await this.sendEmail(
      recipient,
      'Your LoanPlus administrator sign-in code',
      `Your sign-in code is ${code}. It expires in five minutes. If you did not request this code, contact your system operator.`,
    );
  }

  async sendPasswordReset(recipient: string, token: string): Promise<void> {
    const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
    const resetUrl = new URL('/reset-password', origin);
    resetUrl.searchParams.set('token', token);
    await this.sendEmail(
      recipient,
      'Reset your LoanPlus password',
      `Use this one-time link to reset your password: ${resetUrl.toString()}\nIf you did not request this, you can ignore this message.`,
    );
  }

  private async sendEmail(to: string, subject: string, text: string): Promise<void> {
    const apiKey = this.requiredSetting('RESEND_API_KEY');
    const from = this.requiredSetting('RESEND_FROM');
    const senderAddress = from.includes('<') && from.endsWith('>')
      ? from.slice(from.lastIndexOf('<') + 1, -1).trim()
      : from;
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(senderAddress)) {
      this.logger.error('Required email delivery setting RESEND_FROM is invalid.');
      throw new ServiceUnavailableException('Email delivery is unavailable.');
    }

    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      this.logger.error('Resend email delivery request failed (network or timeout).');
      throw new ServiceUnavailableException('Email delivery is unavailable.');
    }

    if (!response.ok) {
      this.logger.error(`Resend email delivery request failed (HTTP ${response.status}).`);
      throw new ServiceUnavailableException('Email delivery is unavailable.');
    }
  }

  private requiredSetting(name: string): string {
    const value = process.env[name];
    if (!value?.trim()) {
      this.logger.error(`Required Resend email setting ${name} is missing.`);
      throw new ServiceUnavailableException('Email delivery is unavailable.');
    }
    return value;
  }
}