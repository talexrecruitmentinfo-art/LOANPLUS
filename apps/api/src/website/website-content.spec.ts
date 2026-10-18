import { BadRequestException } from '@nestjs/common';
import { DEFAULT_WEBSITE_CONTENT, validateWebsiteContent } from './website-content';

describe('validateWebsiteContent', () => {
  it('accepts the fully populated default public content', () => {
    expect(validateWebsiteContent(DEFAULT_WEBSITE_CONTENT)).toEqual(DEFAULT_WEBSITE_CONTENT);
  });

  it('rejects unsafe destinations, non-hex colors and unapproved icon content', () => {
    const unsafeLink = structuredClone(DEFAULT_WEBSITE_CONTENT);
    unsafeLink.hero.primaryHref = 'javascript:alert(1)';
    expect(() => validateWebsiteContent(unsafeLink)).toThrow(BadRequestException);

    const invalidColor = structuredClone(DEFAULT_WEBSITE_CONTENT);
    invalidColor.branding.primaryColor = 'green';
    expect(() => validateWebsiteContent(invalidColor)).toThrow(BadRequestException);

    const invalidIcon = structuredClone(DEFAULT_WEBSITE_CONTENT);
    invalidIcon.features[0].icon = '<svg onload=alert(1)>';
    expect(() => validateWebsiteContent(invalidIcon)).toThrow(BadRequestException);
  });

  it('rejects edits that remove payment-confirmation and no-guaranteed-approval disclosures', () => {
    const invalidStep = structuredClone(DEFAULT_WEBSITE_CONTENT);
    invalidStep.steps.find((step) => step.id === 'submit')!.description = 'Submitting starts automatically after M-Pesa prompt.';
    expect(() => validateWebsiteContent(invalidStep)).toThrow(/payment disclosures/);

    const hiddenFaq = structuredClone(DEFAULT_WEBSITE_CONTENT);
    hiddenFaq.faqs[0].visible = false;
    expect(() => validateWebsiteContent(hiddenFaq)).toThrow(/processing-fee FAQ/);
  });
});
