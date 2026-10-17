import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  async sendSuperadminOtp(recipient: string, code: string): Promise<void> {
    const transporter = this.createTransporter();
    await transporter.sendMail({
      from: this.requiredSetting('SMTP_FROM'),
      to: recipient,
      subject: 'Your LoanPlus administrator sign-in code',
      text: `Your sign-in code is ${code}. It expires in five minutes. If you did not request this code, contact your system operator.`,
    });
  }

  async sendPasswordReset(recipient: string, token: string): Promise<void> {
    const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
    const resetUrl = new URL('/reset-password', origin);
    resetUrl.searchParams.set('token', token);
    const transporter = this.createTransporter();
    await transporter.sendMail({
      from: this.requiredSetting('SMTP_FROM'),
      to: recipient,
      subject: 'Reset your LoanPlus password',
      text: `Use this one-time link to reset your password: ${resetUrl.toString()}\nIf you did not request this, you can ignore this message.`,
    });
  }

  private createTransporter(): nodemailer.Transporter {
    const host = this.requiredSetting('SMTP_HOST');
    const user = this.requiredSetting('SMTP_USER');
    const password = this.requiredSetting('SMTP_PASSWORD');
    const port = Number(process.env.SMTP_PORT ?? 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ServiceUnavailableException('Email delivery is unavailable.');
    }
    return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass: password } });
  }

  private requiredSetting(name: string): string {
    const value = process.env[name];
    if (!value) throw new ServiceUnavailableException('Email delivery is unavailable.');
    return value;
  }
}