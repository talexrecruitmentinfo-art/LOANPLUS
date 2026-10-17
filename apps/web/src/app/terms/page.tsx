import Link from 'next/link';

export default function TermsPage() {
  return (
    <main className="legal-page">
      <Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link>
      <p className="eyebrow">LEGAL INFORMATION · DRAFT FOR REVIEW</p>
      <h1>Terms and Conditions</h1>
      <p className="legal-warning">
        <strong>Pending owner and legal/compliance review and approval.</strong> This draft is not an approved
        customer contract and is not ready for production use. Do not rely on it as legal advice or as evidence
        of any licence, regulatory approval, or business fact. Complete every owner-input item, verify the
        disclosures against the actual service, obtain approval, publish the final terms, and only then configure
        a matching non-draft <code>TERMS_VERSION</code>.
      </p>
      <p><strong>Draft document version:</strong> 1.0 (unapproved; do not use as a production <code>TERMS_VERSION</code>)</p>
      <p><strong>Effective date:</strong> [OWNER TO COMPLETE AFTER APPROVAL]</p>

      <h2>1. Who provides the service</h2>
      <p>
        The LoanPlus website and related account services (the “Service”) are operated by the owner-identified
        legal entity <strong>Airswif</strong>. The owner supplied company reference
        <strong> PVT_2451</strong>; its official registration number, jurisdiction, and legal status remain
        unverified and must be confirmed before publication. Its registered address is
        <strong> [OWNER: confirm registered address]</strong>. The owner has supplied the business address
        RNG Plaza, 2nd Floor, Nairobi, Kenya, and customer support contacts
        <a href="mailto:loanplus.info@gmail.com">loanplus.info@gmail.com</a> and
        <a href="tel:+254107052973">+254107052973</a>. Verify these details before publication; the supplied
        business address is not represented as the registered office. Confirm that these contacts are monitored
        for customer support and complaints, and provide service hours before publication.
      </p>
      <p>
        The owner must have Kenyan counsel confirm which laws and regulatory requirements apply to the actual
        lending and payment model, including whether the Central Bank of Kenya (Digital Credit Providers)
        Regulations, 2022, the Consumer Protection Act, 2012, or other financial-services requirements apply.
        This draft does not claim that LoanPlus or its operator is licensed, authorised, registered, or exempt.
        Complete this statement after verification: <strong>[OWNER: verified regulatory status and any required
        licence/approval reference, or counsel-approved wording if not applicable]</strong>.
      </p>

      <h2>2. Who may use the Service and these terms</h2>
      <p>
        These terms govern access to the Service, account registration, loan applications, and any payment
        feature made available to you. By creating an account or using a feature, you confirm that you have
        read the applicable terms and privacy notice. You must provide accurate information, keep it current,
        and use the Service lawfully. Do not use another person’s account or provide information without
        authority.
      </p>
      <p>
        <strong>[OWNER: confirm minimum customer age, capacity requirements, territories served, and any
        eligibility restrictions before publication.]</strong> The current registration flow collects a National
        ID number but does not verify identity documents or establish that a person is eligible to borrow.
      </p>

      <h2>3. Accounts and security</h2>
      <p>
        You are responsible for protecting your sign-in details and for activity carried out through your
        authenticated account, subject to rights and protections that cannot be excluded by law. Notify
        <strong> [OWNER: approved account-security contact]</strong> promptly if you suspect unauthorised
        access. We may suspend access where reasonably necessary to protect customers, the Service, or legal
        obligations, and will communicate decisions where required by law.
      </p>

      <h2>4. Loan applications and decisions</h2>
      <p>
        Available products may show a principal range, duration, charges, product terms version, and other
        information. Availability can change. An application is a request only: submission does not guarantee
        eligibility, approval, an offer, or disbursement. Loan applications are reviewed by an administrator;
        this draft makes no claim that a particular credit-scoring or automated decision system is used.
        A proposed principal range of KSh 500–5,000 has been supplied for consideration, but it is not
        verified or configured here and is not an available or approved loan offer.
      </p>
      <p>
        The current customer website lists products and loan application status, but does not provide a
        customer-facing application form or an approved-offer presentation and acceptance screen. Session-
        protected API routes for applications and offer acceptance exist. The acceptance route records an
        acceptance time and product terms-version string, but does not save a snapshot of the full offer or
        agreement presented to the customer. Do not treat these backend routes as a complete customer loan
        application or agreement process. Before offering loans, the owner must implement and verify a
        customer flow that presents the approved amount, all charges, total repayable, due dates and payment
        method, late-payment consequences, and applicable cancellation and complaint rights before an
        informed acceptance, and preserves the exact accepted disclosure.
      </p>
      <p>
        An accepted offer creates a loan record, but an administrator manually confirms disbursement. The
        customer website does not currently show the resulting loan or disbursement record. An application,
        approval, recorded offer acceptance, or pending status is not proof that funds have been disbursed.
        The owner must provide customers with an accurate disbursement confirmation and reference.
      </p>

      <h2>5. Repayment and charges</h2>
      <p>
        You must repay only amounts properly disclosed in your accepted loan agreement and required by
        applicable law. The amount, allocation between principal and charges, due dates, and any late-payment
        consequences must be stated in that agreement before you accept. No interest rate, fee, penalty, or
        collection cost is set by these general terms; the owner must ensure that each product and customer
        offer lawfully discloses all applicable amounts.
      </p>
      <p>
        The database supports repayment schedules and repayment records, but the customer-facing repayment
        collection flow is not currently implemented. Until a repayment method is expressly provided in a
        valid individual loan agreement and is operational, do not infer that an in-app payment option exists.
        <strong> [OWNER: confirm repayment channels, payment allocation, receipts, reconciliation process,
        overdue handling, and legally compliant collections before offering loans.]</strong>
      </p>

      <h2>6. Activation and M-Pesa payments</h2>
      <p>
        Account activation payments are not an assumed or universal requirement. The Service can initiate an
        M-Pesa Daraja STK Push only when the owner has configured and approved an activation amount and
        customer-facing policy, required ledger accounts are available, and payment credentials and callback
        settings are configured. Live processing is separately disabled unless expressly enabled by the
        operator. These technical controls do not themselves establish that an activation payment is lawful,
        appropriate, refundable, or approved for production.
      </p>
      <p>
        The current activation screen displays the amount, purpose, refundability, wallet treatment, customer
        disclosure, and configured terms-version string, and requires a checkbox before requesting an STK
        Push. It does not display the separate internal accounting-treatment field. The provider callback is
        checked against a Daraja status query before the payment is confirmed, but no scheduled retry or
        reconciliation worker is implemented. An uncertain initiation or missing callback can therefore
        remain pending; do not make another payment while the first is pending. A payment prompt is not proof
        of payment, and activation follows only after confirmed success. The application stores its own
        transaction reference but currently does not retain or display the Safaricom receipt number; keep
        Safaricom&apos;s confirmation and contact <strong>loanplus.info@gmail.com or +254107052973</strong>
        promptly about an unrecognised, duplicated, failed, or unreconciled payment. The owner must verify and
        monitor these supplied contacts. No in-app refund or cancellation workflow is implemented. The owner
        has mentioned a possible KSh 50 activation fee, but this amount is unverified, is not a configured
        customer term, and must not be charged or represented as approved without separate review and approval.
        The owner must approve and operationalise accurate refund, cancellation, and complaint terms before
        enabling any payment policy.
      </p>
      <p>
        Daraja processing may involve Safaricom and its payment systems. We do not promise uninterrupted
        provider availability. Do not send money to a number or payee unless the in-product instructions and
        payment details have been verified.
      </p>

      <h2>7. Referrals and support</h2>
      <p>
        The Service provides referral codes and displays referral status. No referral reward is promised by
        these terms: the current customer view reports that rewards are not configured. The owner must publish
        separate eligibility, value, timing, tax, and dispute terms before offering a reward. The referral
        screen displays a referred customer’s name and referral status. A possible KSh 25 referral reward has
        been mentioned but is unverified, is not configured, and is not promised. Do not submit another person’s
        details without their authority.
      </p>
      <p>
        Signed-in customers can submit support tickets and messages through the Service. Do not include
        passwords, full National ID numbers, payment PINs, or other unnecessary sensitive information in a
        support message. The support channel is not a substitute for a legally required formal complaint or
        regulatory escalation process. The owner has supplied loanplus.info@gmail.com and +254107052973 as
        support and complaint contacts; verify and monitor them before publication. The complaint handling
        procedure, reference tracking, response targets, and external escalation body/contact still require
        owner and legal review.
      </p>

      <h2>8. Suspension, changes, and service availability</h2>
      <p>
        We may maintain, update, or temporarily restrict the Service for security, operational, or legal
        reasons. We will not use a change to these general terms to alter an existing loan’s agreed financial
        terms without the legally required notice and agreement. The owner must decide and document how
        material changes will be notified and how consent to revised terms will be recorded.
      </p>

      <h2>9. Complaints and applicable law</h2>
      <p>
        Contact <strong>loanplus.info@gmail.com or +254107052973</strong> about a complaint, once the owner
        has verified these supplied details are monitored for complaints. The owner must complete the complaint
        handling procedure, response targets,
        escalation pathway, and any required regulator or alternative dispute-resolution information before
        publication. These terms are intended to be governed by the laws of Kenya, subject to mandatory
        consumer rights, applicable regulatory requirements, and the jurisdiction rules confirmed by Kenyan
        counsel.
      </p>

      <h2>10. Owner completion and approval record</h2>
      <p>
        Before publication, the owner and legal/compliance reviewer must complete all bracketed items,
        reconcile these terms with each product and payment disclosure, confirm applicable licences and
        consumer protections, and approve the final text. Record the final document version, approval date,
        and effective date. Configure the exact approved version as <code>TERMS_VERSION</code>; do not use a
        draft or test value in production.
      </p>
      <Link className="legal-home" href="/">Return to LoanPlus home ↗</Link>
    </main>
  );
}
