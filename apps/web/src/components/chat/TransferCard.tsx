'use client';

import React from 'react';

type Props = {
  amount: number;
  token?: string;
  txHash: string;
};

export default function TransferCard({ amount, token = 'TOKEN', txHash }: Props) {
  const network = process.env.NEXT_PUBLIC_NETWORK || 'test';
  const explorer = `https://explorer.stellar.org/tx/${txHash}?network=${network}`;
  return (
    <div className="border rounded-md p-3 bg-yellow-50">
      <div className="text-sm font-medium">💰 Transfer</div>
      <div className="mt-1">
        <strong>{amount}</strong> {token}
      </div>
      <div className="mt-2 text-xs text-blue-600">
        <a href={explorer} target="_blank" rel="noreferrer">
          View on explorer
        </a>
      </div>
    </div>
  );
}
