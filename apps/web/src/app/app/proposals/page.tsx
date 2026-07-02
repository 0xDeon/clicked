'use client';

import React, { useState } from 'react';

interface Proposal {
  id: string;
  title: string;
  creator: string;
  description: string;
  status: 'Active' | 'Succeeded' | 'Defeated';
  yesVotes: number;
  noVotes: number;
  endsIn: string;
  voted?: 'yes' | 'no';
}

export default function ProposalsPage() {
  const [proposals, setProposals] = useState<Proposal[]>([
    {
      id: '1',
      title: 'CP-024: Allocate 50,000 XLM for Stellar-Rust SDK Improvements',
      creator: '0xDeon',
      description:
        'Upgrade the Stellar Rust SDK to improve memory safety and efficiency for smart contracts, introducing robust bindings and better transaction helpers.',
      status: 'Active',
      yesVotes: 324000,
      noVotes: 42000,
      endsIn: '2 days left',
    },
    {
      id: '2',
      title: 'CP-023: Deploy Multi-Sig Messaging Vault V2',
      creator: 'Jed McCaleb',
      description:
        'Migrate current community multisig wallets to the audited V2 standard, adding instant chat-based transaction signing flows directly through the UI.',
      status: 'Succeeded',
      yesVotes: 512000,
      noVotes: 12000,
      endsIn: 'Ended 1 day ago',
    },
    {
      id: '3',
      title: 'CP-022: Increase Validator Quorum to 7 Members',
      creator: 'StellarDev',
      description:
        'Proposed increase of validator consensus threshold nodes from 5 to 7 to improve fault tolerance and absolute decentralization metrics.',
      status: 'Defeated',
      yesVotes: 110000,
      noVotes: 240000,
      endsIn: 'Ended 5 days ago',
    },
  ]);

  const handleVote = (id: string, type: 'yes' | 'no') => {
    setProposals(
      proposals.map((prop) => {
        if (prop.id !== id || prop.status !== 'Active' || prop.voted) return prop;
        return {
          ...prop,
          voted: type,
          yesVotes: type === 'yes' ? prop.yesVotes + 10000 : prop.yesVotes,
          noVotes: type === 'no' ? prop.noVotes + 10000 : prop.noVotes,
        };
      }),
    );
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight bg-gradient-to-r from-white via-foreground to-accent-light bg-clip-text text-transparent">
            Governance Proposals
          </h1>
          <p className="text-sm text-foreground/40 mt-1">
            Vote on community improvements and treasury resource allocations.
          </p>
        </div>
        <button className="self-start md:self-center px-4 py-2.5 rounded-xl bg-accent hover:bg-accent-light text-white text-xs font-semibold shadow-md shadow-accent/20 transition-all duration-300 hover:scale-105 active:scale-95">
          New Proposal
        </button>
      </div>

      {/* Proposals list */}
      <div className="space-y-5">
        {proposals.map((prop) => {
          const totalVotes = prop.yesVotes + prop.noVotes;
          const yesPercent = totalVotes > 0 ? Math.round((prop.yesVotes / totalVotes) * 100) : 0;
          const noPercent = totalVotes > 0 ? 100 - yesPercent : 0;

          return (
            <div
              key={prop.id}
              className="p-6 rounded-3xl bg-card/30 border border-border backdrop-blur-md relative overflow-hidden group hover:border-white/[0.08] transition-all duration-300"
            >
              {/* Status Badge */}
              <div className="flex items-center justify-between gap-4 mb-4">
                <span className="text-xs text-foreground/40 font-mono">
                  Created by <span className="text-accent-light">{prop.creator}</span>
                </span>
                <span
                  className={`px-2.5 py-0.5 rounded-md text-[10px] font-bold border ${
                    prop.status === 'Active'
                      ? 'text-accent-light bg-accent/10 border-accent/20 animate-pulse'
                      : prop.status === 'Succeeded'
                        ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                        : 'text-rose-400 bg-rose-500/10 border-rose-500/20'
                  }`}
                >
                  {prop.status}
                </span>
              </div>

              {/* Title & Description */}
              <h3 className="text-base md:text-lg font-bold text-foreground mb-2 group-hover:text-white transition-colors duration-300">
                {prop.title}
              </h3>
              <p className="text-xs md:text-sm text-foreground/60 leading-relaxed mb-6">
                {prop.description}
              </p>

              {/* Progress & Voting controls */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-end">
                {/* Voting stats bars */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-foreground/80 flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-accent inline-block" />
                      Yes ({yesPercent}%)
                    </span>
                    <span className="font-semibold text-foreground/80 flex items-center gap-1.5">
                      No ({noPercent}%)
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block" />
                    </span>
                  </div>
                  <div className="h-2 w-full bg-white/[0.03] rounded-full overflow-hidden flex">
                    <div
                      className="h-full bg-accent rounded-l-full"
                      style={{ width: `${yesPercent}%` }}
                    />
                    <div
                      className="h-full bg-rose-500 rounded-r-full"
                      style={{ width: `${noPercent}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-foreground/30 font-mono">
                    <span>{prop.yesVotes.toLocaleString()} XLM</span>
                    <span>{prop.noVotes.toLocaleString()} XLM</span>
                  </div>
                </div>

                {/* Vote actions */}
                <div className="flex items-center justify-end gap-3.5">
                  <span className="text-[10px] text-foreground/30 font-mono mr-auto md:mr-0">
                    {prop.endsIn}
                  </span>

                  {prop.status === 'Active' && (
                    <>
                      {prop.voted ? (
                        <span className="text-xs font-semibold px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-foreground/60">
                          Voted {prop.voted === 'yes' ? 'Yes' : 'No'}
                        </span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleVote(prop.id, 'no')}
                            className="px-3.5 py-2 rounded-xl border border-rose-500/20 hover:border-rose-500/50 bg-rose-500/5 hover:bg-rose-500/10 text-rose-400 text-xs font-bold transition-all duration-300"
                          >
                            Vote No
                          </button>
                          <button
                            onClick={() => handleVote(prop.id, 'yes')}
                            className="px-3.5 py-2 rounded-xl border border-accent/20 hover:border-accent/50 bg-accent/5 hover:bg-accent/10 text-accent-light text-xs font-bold transition-all duration-300"
                          >
                            Vote Yes
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
