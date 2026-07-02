import React, { useState, useEffect } from 'react';

export type ProposalStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'expired';

interface ProposalCardProps {
  proposal: {
    id: string;
    status: ProposalStatus;
    expiryLedger: number; // Block index target for expiration
  };
  currentLedger: number; // Passed from global ledger context state sync
  isMember: boolean;
  onExecute: (id: string) => void;
  onFinalize: (id: string) => void;
}

export const ProposalCard: React.FC<ProposalCardProps> = ({
  proposal,
  currentLedger,
  isMember,
  onExecute,
  onFinalize,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(
    proposal.status === 'executed' || proposal.status === 'rejected',
  );
  const [timeLeft, setTimeLeft] = useState('');

  // Calculate countdown: 1 ledger ≈ 5s. Updates every minute.
  useEffect(() => {
    const calculateTime = () => {
      if (proposal.status !== 'pending') return;
      const ledgersLeft = proposal.expiryLedger - currentLedger;
      if (ledgersLeft <= 0) {
        setTimeLeft('Expired');
        return;
      }
      const totalSeconds = ledgersLeft * 5;
      const minutes = Math.floor(totalSeconds / 60);
      setTimeLeft(`${minutes}m left`);
    };

    calculateTime();
    const interval = setInterval(calculateTime, 60000); // 1-minute updates
    return () => clearInterval(interval);
  }, [currentLedger, proposal.expiryLedger, proposal.status]);

  // Map explicitly defined color configurations
  const badgeColors: Record<ProposalStatus, string> = {
    pending: 'bg-yellow-500 text-black',
    approved: 'bg-blue-500 text-white',
    executed: 'bg-green-500 text-white',
    rejected: 'bg-red-500 text-white',
    expired: 'bg-gray-500 text-white',
  };

  return (
    <div className="border p-4 rounded mb-4 shadow-sm">
      <div className="flex justify-between items-center">
        <h3>Proposal #{proposal.id}</h3>
        <span className={`px-2 py-1 rounded text-sm ${badgeColors[proposal.status]}`}>
          {proposal.status.toUpperCase()}
        </span>
      </div>

      {/* Expiry Countdown for pending proposals */}
      {proposal.status === 'pending' && <p className="text-sm text-gray-500 mt-1">{timeLeft}</p>}

      {/* Collapsible content section toggle wrapper */}
      {(proposal.status === 'executed' || proposal.status === 'rejected') && (
        <button className="text-xs underline mt-2" onClick={() => setIsCollapsed(!isCollapsed)}>
          {isCollapsed ? 'Show Past Details' : 'Hide Details'}
        </button>
      )}

      {!isCollapsed && (
        <div className="mt-4 flex gap-2">
          {/* Execute button only visible to verified members when status is approved */}
          {proposal.status === 'approved' && isMember && (
            <button
              className="btn bg-blue-600 text-white px-4 py-2"
              onClick={() => onExecute(proposal.id)}
            >
              Execute Withdrawal
            </button>
          )}

          {/* Expired proposals replace approve/reject with a Finalize button */}
          {proposal.status === 'expired' && (
            <button
              className="btn bg-gray-700 text-white px-4 py-2"
              onClick={() => onFinalize(proposal.id)}
            >
              Finalize
            </button>
          )}
        </div>
      )}
    </div>
  );
};
