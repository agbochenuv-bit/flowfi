import { describe, it, expect } from 'vitest';
import { TransactionProgressBarStories } from './transaction-progress-bar.stories';

describe('Transaction Progress Bar Stories Specification', () => {
  it('covers all transaction lifecycle states', () => {
    const storyKeys = Object.keys(TransactionProgressBarStories);
    expect(storyKeys).toContain('Idle');
    expect(storyKeys).toContain('Signing');
    expect(storyKeys).toContain('Submitted');
    expect(storyKeys).toContain('Confirming');
    expect(storyKeys).toContain('Confirmed');
    expect(storyKeys).toContain('Failed');
    expect(storyKeys).toContain('Cancelled');
  });

  it('configures valid transaction actions and status strings', () => {
    for (const [name, story] of Object.entries(TransactionProgressBarStories)) {
      expect(story.props.status).toBeDefined();
      expect(story.props.action).toBeDefined();
    }
  });

  it('includes error messages for failed and cancelled states', () => {
    expect(TransactionProgressBarStories.Failed.props.error).toBeDefined();
    expect(TransactionProgressBarStories.Failed.props.errorCode).toBeDefined();
    expect(TransactionProgressBarStories.Cancelled.props.error).toBeDefined();
  });
});
