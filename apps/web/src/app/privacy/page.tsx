import Link from 'next/link';

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link>
      <p className="eyebrow">LEGAL INFORMATION · DRAFT FOR REVIEW</p>
      <h1>Privacy Policy</h1>
      <p className="legal-warning">
        <strong>Pending owner and legal/compliance review and approval.</strong> This draft is not an approved
        privacy notice and is not ready for production use. The operator, privacy contact, retention periods,
        processors, processing locations, and some legal bases still require owner confirmation. Complete every
        owner-input item and verify this notice against actual operations before publishing or collecting real
        customer data.
      </p>
      <p><strong>Draft document version:</strong> 1.0 (unapproved; do not use as a production <code>PRIVACY_VERSION</code>)</p>
      <p><strong>Effective date:</strong> [OWNER TO COMPLETE AFTER APPROVAL]</p>

      <h2>1. Who is responsible for your personal data</h2>
      <p>
        The owner identifies the data controller as the legal entity <strong>Airswif</strong> and supplied
        company reference <strong>PVT_2451</strong>. Its official registration number, jurisdiction, and legal
        status remain unverified and must be confirmed before publication;
        with registered address <strong>[OWNER: confirm registered address]</strong>. The owner has supplied
        the business address RNG Plaza, 2nd Floor, Nairobi, Kenya, and customer support contacts
        <a href="mailto:loanplus.info@gmail.com">loanplus.info@gmail.com</a> and
        <a href="tel:+254107052973">+254107052973</a>. Verify these details before publication; the supplied
        business address is not represented as the registered office. The owner must confirm that these
        contacts are monitored for privacy requests and identify any privacy/DPO contact required by law.
      </p>
      <p>
        This notice is intended to address obligations under Kenya’s Data Protection Act, 2019 and applicable
        regulations, including the Data Protection (General) Regulations, 2021 and the Data Protection
        (Registration of Data Controllers and Data Processors) Regulations, 2021. The owner must obtain advice
        on the applicable obligations, registration status, and whether a data protection officer or impact
        assessment is required. This notice does not claim that the operator is registered or otherwise approved.
      </p>

      <h2>2. Personal data the Service handles</h2>
      <p>Depending on the feature you use, the Service may handle:</p>
      <ul>
        <li>
          <strong>Account and identity details:</strong> full name, email address, Kenyan phone number, National
          ID number, account status, and referral code. The ID number is encrypted in storage and a separate
          keyed digest is used for duplicate checks. This is not identity verification; registration does not
          request an ID-card or passport image. Identity verification is proposed but not currently implemented.
        </li>
        <li>
          <strong>Authentication and security records:</strong> password hashes, session and password-reset
          token digests, account/session status, security events, and administrative audit records. Passwords
          and raw session tokens are not intended to be stored in plaintext.
        </li>
        <li>
          <strong>Consent and lending records:</strong> accepted Terms and Privacy Policy version identifiers
          and timestamps; loan product, requested and approved amounts, guarantor names and phone numbers,
          application fee and decision details, accepted product terms-version string, disbursement reference,
          and scheduled or recorded repayment information where created.
        </li>
        <li>
          <strong>Payments:</strong> transaction amount, currency, status, internal and provider references,
          timestamps, callback result codes and a hash of each callback payload, and the registered phone
          number used for a loan processing-fee request. That payment phone number is encrypted in storage. A Safaricom receipt
          number is checked during successful callback processing but is not stored in the payment or callback
          record. M-Pesa PINs are not requested by this Service.
        </li>
        <li>
          <strong>Referrals and support:</strong> referral code, referral relationship and status, reward status
          if configured, support-ticket subject and messages, ticket status, and associated timestamps. The
          referral screen displays the referred customer’s name and referral status to the referrer. The
          customer referral response does not need or expose the referred customer’s account activation status.
        </li>
        <li>
          <strong>Operational data:</strong> request IP address may be recorded in authentication or
          administrative audit entries, along with timestamps and action/outcome information. No analytics or
          advertising integration was found in the reviewed application source; the owner must verify all
          application, hosting, security, and provider logging before publication.
        </li>
      </ul>

      <h2>3. Why data is used and the applicable basis</h2>
      <p>Subject to confirmation by the controller and Kenyan counsel, data is used to:</p>
      <ul>
        <li>create and secure accounts, authenticate users, process password resets, and prevent duplicate or abusive registrations;</li>
        <li>record consent to the applicable terms and privacy notice;</li>
        <li>record and review loan applications, decisions and offers, accepted offer details, and disbursement records where those features are used;</li>
        <li>initiate and reconcile the KSh 50 loan processing fee required before an application is submitted;</li>
        <li>operate referral tracking and respond to support requests;</li>
        <li>maintain audit, accounting, security, and dispute records; and</li>
        <li>comply with legal obligations, respond to lawful requests, and establish or defend legal claims.</li>
      </ul>
      <p>
        The controller must identify and document the lawful basis for each purpose, which may include steps
        requested before entering a contract, performance of a contract, compliance with a legal obligation,
        legitimate interests where legally available and balanced, or consent where required. Consent is not a
        substitute for identifying the correct legal basis. If processing relies on consent, you may withdraw
        it without affecting processing already lawfully carried out; some services may then be unavailable.
        <strong> [OWNER: approve the purpose-to-lawful-basis mapping and any required notices or consent
        language.]</strong>
      </p>

      <h2>4. Who data may be shared with</h2>
      <p>Access is limited to what is needed for the relevant purpose. Depending on enabled services, recipients may include:</p>
      <ul>
        <li>
          authorised LoanPlus staff and administrators who review applications, manage support, reconcile
          payments, or maintain security and audit records;
        </li>
        <li>
          infrastructure, database, email, security, and other service providers acting on the controller’s
          documented instructions and subject to appropriate safeguards;
        </li>
        <li>
          Safaricom/Daraja for an M-Pesa activation STK Push and callback status check, when enabled; and
          Resend for password-reset or administrator verification email, as configured;
        </li>
        <li>
          a person who referred you, through the referral feature’s display of your name and referral status
          to that referrer; and
        </li>
        <li>
          courts, regulators, law enforcement, or other recipients where disclosure is required or permitted by
          applicable law, or necessary to protect legal rights.
        </li>
      </ul>
      <p>
        The current implementation does not verify identity documents and does not implement credit-reference
        bureau checks or disclosures. Do not represent those checks or disclosures as occurring unless the
        owner implements them, verifies the legal basis and required notice, and updates this policy first.
        Repository deployment instructions refer to Supabase for PostgreSQL, Render for the API, Vercel for
        the website, Resend for email, and Safaricom Daraja for loan processing-fee payments; these references do not
        establish which services are actually used in production, their contractual roles, subprocessors, or
        the data each receives. <strong>[OWNER: verify and list actual providers, their roles, data shared,
        contract safeguards, and any other recipients before approval.]</strong>
      </p>

      <h2>5. Transfers and processing locations</h2>
      <p>
        Providers may process or store data in Kenya or elsewhere. The owner has not supplied a confirmed
        inventory of provider locations or cross-border transfer safeguards. Before publication, identify each
        provider and processing country, assess applicable Kenyan transfer requirements, document any required
        safeguards, and disclose the relevant information here:
        <strong> [OWNER: verified provider locations, transfer destinations, and safeguards or approved
        statement that no cross-border transfer occurs]</strong>.
      </p>

      <h2>6. Retention</h2>
      <p>
        The Service stores account, consent, loan, payment, audit, referral, and support records. This
        implementation does not specify a complete deletion or retention schedule, and some records are
        constrained by financial, audit, and relational records. Data should be retained only for as long as
        necessary for the stated purpose or as required by law, then securely deleted or anonymised where
        appropriate. The owner must determine and publish actual periods and disposal rules by data category,
        including any legal holds:
        <strong> [OWNER: provide the approved retention schedule and deletion/anonymisation process; do not
        publish an invented duration]</strong>.
      </p>
      <p>
        The current application does not provide self-service account deletion, data export, or a formal
        privacy-rights request workflow. The owner must establish and test a monitored contact process for
        access, correction, deletion, objection, and other applicable requests, including identity verification,
        response tracking, and lawful retention exceptions, before collecting real customer data.
      </p>

      <h2>7. Your rights and choices</h2>
      <p>
        Subject to the Data Protection Act, 2019, applicable regulations, and lawful exceptions, you may have
        rights to be informed about processing, access your personal data, request correction of inaccurate or
        misleading data, request deletion, object to processing, request restriction where applicable, and
        exercise rights concerning solely automated decisions where applicable. You may withdraw consent when
        consent is the applicable basis. Some requests may be limited where the controller must retain or
        process data under law or to establish, exercise, or defend legal claims.
      </p>
      <p>
        To exercise a right, contact <strong>loanplus.info@gmail.com or +254107052973</strong> and provide enough
        information for the controller to locate your record and verify your request securely. The controller
        must respond within applicable legal timelines and explain any lawful refusal or limitation. You may
        also lodge a complaint with Kenya’s Office of the Data Protection Commissioner (ODPC). The owner must
        verify that these owner-supplied contacts are monitored for privacy requests and add any required ODPC
        contact or complaint instructions before publication.
      </p>

      <h2>8. Security</h2>
      <p>
        The implementation includes encryption for stored National ID and activation phone numbers, keyed
        digests for National ID duplicate checks, password hashing, hashed session/reset tokens, access controls,
        and audit records. These measures reduce risk but cannot guarantee absolute security. The owner must
        verify production configuration, key custody and rotation, staff access, provider safeguards, backups,
        incident response, and any applicable breach notification procedure before processing real customer
        data. Do not send passwords, M-Pesa PINs, or full National ID numbers through support messages.
      </p>

      <h2>9. Cookies and essential service operation</h2>
      <p>
        The customer and administrator sign-in flows use separate HTTP-only session cookies. Production
        settings mark them Secure and use SameSite=None for the separate website and API origins. No analytics
        or advertising cookie integration was found in the reviewed application source. The owner must verify
        cookie configuration and all hosting/provider logs, and disclose any additional analytics, advertising,
        or non-essential tracking before enabling it.
      </p>

      <h2>10. Children and eligibility</h2>
      <p>
        The minimum age and process for handling a child’s data have not been confirmed. The owner must obtain
        legal advice, decide and implement the applicable age and eligibility controls, and complete this
        notice with an approved statement before publication:
        <strong> [OWNER: specify the age rule, child-data process if relevant, and responsible contact]</strong>.
      </p>

      <h2>11. Changes and privacy contact</h2>
      <p>
        If this notice changes, the controller must determine when notice or renewed consent is required, make
        the current version available, and record the version and acceptance where applicable. Contact
        <strong> loanplus.info@gmail.com or +254107052973</strong> for questions or requests. These contacts
        were supplied by the owner and must be verified, monitored, and confirmed as the appropriate privacy
        channel; the legal controller identity and any required DPO contact remain to be completed.
      </p>

      <h2>12. Owner completion and approval record</h2>
      <p>
        Before publication, the owner and legal/compliance reviewer must complete every bracketed item;
        confirm the controller and any required registration; map processing purposes to lawful bases; verify
        providers, locations, safeguards, cookies, retention, rights handling, and breach response; and approve
        the final notice. Record the final document version, approval date, and effective date. Configure the
        exact approved version as <code>PRIVACY_VERSION</code>; do not use a draft or test value in production.
      </p>
      <Link className="legal-home" href="/">Return to LoanPlus home ↗</Link>
    </main>
  );
}
