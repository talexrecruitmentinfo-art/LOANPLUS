export const LOAN_PROCESSING_FEE_KES = 50;

export interface LoanProcessingFeePolicy {
	status: 'CONFIGURED' | 'NOT_CONFIGURED';
	version: string | null;
	disclosure: string | null;
}

export function getLoanProcessingFeePolicy(): LoanProcessingFeePolicy {
	const version = process.env.LOAN_PROCESSING_FEE_POLICY_VERSION?.trim() ?? '';
	const disclosure = process.env.LOAN_PROCESSING_FEE_POLICY_DISCLOSURE?.trim() ?? '';
	const approved = process.env.LOAN_PROCESSING_FEE_POLICY_APPROVED === 'true';
	const validVersion = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(version) && !/^draft(?:[-_. ]|$)/i.test(version);

	if (!approved || !validVersion || disclosure.length < 20 || disclosure.length > 1000) {
		return { status: 'NOT_CONFIGURED', version: null, disclosure: null };
	}
	return { status: 'CONFIGURED', version, disclosure };
}
