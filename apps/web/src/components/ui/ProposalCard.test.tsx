import { render, screen } from '@testing-library/react';
import { ProposalCard } from '../ProposalCard';

describe('ProposalCard Action Requirements', () => {
  it('renders Execute button only if user is a member and proposal is approved', () => {
    const { rerender } = render(
      <ProposalCard
        proposal={{ id: '1', status: 'approved', expiryLedger: 100 }}
        currentLedger={50}
        isMember={true}
        onExecute={() => {}}
        onFinalize={() => {}}
      />,
    );
    expect(screen.getByText('Execute Withdrawal')).toBeInTheDocument();

    // Re-render with membership set to false
    rerender(
      <ProposalCard
        proposal={{ id: '1', status: 'approved', expiryLedger: 100 }}
        currentLedger={50}
        isMember={false}
        onExecute={() => {}}
        onFinalize={() => {}}
      />,
    );
    expect(screen.queryByText('Execute Withdrawal')).toBeNull();
  });

  it('shows Finalize button instead of choice operations on expired entries', () => {
    render(
      <ProposalCard
        proposal={{ id: '2', status: 'expired', expiryLedger: 40 }}
        currentLedger={50}
        isMember={true}
        onExecute={() => {}}
        onFinalize={() => {}}
      />,
    );
    expect(screen.getByText('Finalize')).toBeInTheDocument();
  });
});
