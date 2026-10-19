import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { LOAN_PROCESSING_FEE_KES } from './processing-fee.constants';
import { getLoanProcessingFeePolicy } from './processing-fee.constants';
import 'reflect-metadata';
import { CustomerSessionGuard } from '../auth/session.guard';
import type { AuthenticatedRequest } from '../auth/request.types';

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
    const quote = {
      amountKes: LOAN_PROCESSING_FEE_KES,
      currency: 'KES',
      refundPolicyStatus: 'NOT_CONFIGURED',
      refundPolicyVersion: null,
      refundPolicyDisclosure: null,
      paymentAvailable: false,
      unavailableReasons: ['Approved processing-fee policy approval is not configured.'],
    };
    const controller = new PaymentController({ getLoanProcessingFeeQuote: jest.fn(async () => quote) } as unknown as PaymentService);

    await expect(controller.getLoanProcessingFeeQuote()).resolves.toEqual({
      data: quote,
    });
  });

  it('returns the authenticated customer unresolved-fee status and guards the endpoint', async () => {
    const unresolved = {
      reference: 'LPP_UNRESOLVED_REFERENCE',
      status: 'PENDING',
      amountKes: 50,
      currency: 'KES',
      initiationPhase: 'STK_REQUEST_OUTCOME_UNCERTAIN',
      createdAt: new Date(),
      message: 'A previous processing-fee payment is unresolved. Do not pay again until it has been reconciled.',
    };
    const getUnresolvedLoanProcessingFeePayment = jest.fn(async () => unresolved);
    const controller = new PaymentController({ getUnresolvedLoanProcessingFeePayment } as unknown as PaymentService);
    const request = { principal: { id: 'customer-id' } } as AuthenticatedRequest;
    const handler = PaymentController.prototype.getUnresolvedLoanProcessingFee;

    await expect(controller.getUnresolvedLoanProcessingFee(request)).resolves.toEqual({ data: unresolved });
    expect(getUnresolvedLoanProcessingFeePayment).toHaveBeenCalledWith('customer-id');
    expect(Reflect.getMetadata('__guards__', handler)).toContain(CustomerSessionGuard);
  });

  it('returns null when no unresolved processing-fee payment exists', async () => {
    const getUnresolvedLoanProcessingFeePayment = jest.fn(async () => null);
    const controller = new PaymentController({ getUnresolvedLoanProcessingFeePayment } as unknown as PaymentService);

    await expect(controller.getUnresolvedLoanProcessingFee({ principal: { id: 'customer-id' } } as never)
    ).resolves.toEqual({ data: null });
    expect(getUnresolvedLoanProcessingFeePayment).toHaveBeenCalledWith('customer-id');
  });

  it('returns only a valid approved non-draft customer policy', async () => {
    process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED = 'true';
    process.env.LOAN_PROCESSING_FEE_POLICY_VERSION = 'approved-v1';
    process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE = 'Refunds follow the approved loan processing-fee policy.';
    const quote = {
      amountKes: LOAN_PROCESSING_FEE_KES,
      currency: 'KES',
      refundPolicyStatus: 'CONFIGURED',
      refundPolicyVersion: 'approved-v1',
      refundPolicyDisclosure: 'Refunds follow the approved loan processing-fee policy.',
      paymentAvailable: false,
      unavailableReasons: ['M-Pesa is not configured.'],
    };
    const controller = new PaymentController({ getLoanProcessingFeeQuote: jest.fn(async () => quote) } as unknown as PaymentService);

    await expect(controller.getLoanProcessingFeeQuote()).resolves.toMatchObject({
      data: {
        refundPolicyStatus: 'CONFIGURED',
        refundPolicyVersion: 'approved-v1',
        refundPolicyDisclosure: 'Refunds follow the approved loan processing-fee policy.',
        paymentAvailable: false,
        unavailableReasons: ['M-Pesa is not configured.'],
      },
    });

    process.env.LOAN_PROCESSING_FEE_POLICY_VERSION = 'draft-v1';
    expect(getLoanProcessingFeePolicy().status).toBe('NOT_CONFIGURED');
  });
});