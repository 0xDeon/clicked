import React from 'react';
import { CopyButton } from './CopyButton';

interface WalletAddressProps {
  address: string;
  linkable?: boolean;
  network?: 'testnet' | 'mainnet';
}

export const WalletAddress: React.FC<WalletAddressProps> = ({
  address,
  linkable = false,
  network = 'testnet',
}) => {
  const truncateAddress = (addr: string): string => {
    if (addr.length < 9) return addr;
    return `${addr.slice(0, 5)}...${addr.slice(-4)}`;
  };

  const getStellarExpertUrl = (addr: string, net: 'testnet' | 'mainnet'): string => {
    const baseUrl =
      net === 'testnet' ? 'https://testnet.expert.stellar.org' : 'https://expert.stellar.org';
    return `${baseUrl}/accounts/${addr}`;
  };

  const truncated = truncateAddress(address);
  const stellarUrl = getStellarExpertUrl(address, network);

  return (
    <div className="flex items-center gap-2">
      {linkable ? (
        <a
          href={stellarUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline font-mono text-sm"
        >
          {truncated}
        </a>
      ) : (
        <span className="font-mono text-sm">{truncated}</span>
      )}
      <CopyButton text={address} />
    </div>
  );
};
