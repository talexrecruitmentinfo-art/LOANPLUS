import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { LOAN_PROCESSING_FEE_KES } from './processing-fee.constants';
import { getLoanProcessingFeePolicy } from './processing-fee.constants';

describe('PaymentController', () => {
  const originalPolicyEnvironment = {
    approved: process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED,
    version: process.env.LOAN_PROCESSING_FEE_POLICY_VERSION,
    disclosure: process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries({
      LOAN_PROCESSING_FEE_POLICY_APPROVED: originalPolicyEnvironment.approved,
      LOAN_PROCESSING_FEE_POLICY_VERSION: originalPolicyEnvironment.version,
      LOAN_PROCESSING_FEE_POLICY_DISCLOSURE: originalPolicyEnvironment.disclosure,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('returns the backend processing-fee amount and explicit refund-policy status', async () => {
    const controller = new PaymentController({} as PaymentService);

    await expect(controller.getLoanProcessingFeeQuote()).resolves.toEqual({
      data: {
        amountKes: LOAN_PROCESSING_FEE_KES,
        currency: 'KES',
        refundPolicyStatus: 'NOT_CONFIGURED',
        refundPolicyVersion: null,
        refundPolicyDisclosure: null,
      },
    });
  });

  it('returns only a valid approved non-draft customer policy', async () => {
    process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED = 'true';
    process.env.LOAN_PROCESSING_FEE_POLICY_VERSION = 'approved-v1';
    process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE = 'Refunds follow the approved loan processing-fee policy.';
    const controller = new PaymentController({} as PaymentService);

    await expect(controller.getLoanProcessingFeeQuote()).resolves.toMatchObject({
      data: {
        refundPolicyStatus: 'CONFIGURED',
        refundPolicyVersion: 'approved-v1',
        refundPolicyDisclosure: 'Refunds follow the approved loan processing-fee policy.',
      },
    });

    process.env.LOAN_PROCESSING_FEE_POLICY_VERSION = 'draft-v1';
    expect(getLoanProcessingFeePolicy().status).toBe('NOT_CONFIGURED');
  });
});