'use client';

import React, { useState, useEffect, useCallback } from "react";
import { ProposeWithdrawalModal } from "@/components/treasury/ProposeWithdrawalModal";
import { ProposalCard, type Proposal } from "@/components/treasury/ProposalCard";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useSocket } from "@/hooks/useSocket";

export default function TreasuryPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { token } = useAuth();
  const socket = useSocket(token);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loadingProposals, setLoadingProposals] = useState(true);

  const assets = [
    {
      name: 'Stellar Lumens',
      symbol: 'XLM',
      balance: '420,500 XLM',
      value: '$42,050.00',
      percentage: '65%',
      color: 'bg-accent',
    },
    {
      name: 'USD Coin',
      symbol: 'USDC',
      balance: '18,200 USDC',
      value: '$18,200.00',
      percentage: '28%',
      color: 'bg-emerald-500',
    },
    {
      name: 'AQUA',
      symbol: 'AQUA',
      balance: '1,250,000 AQUA',
      value: '$4,500.00',
      percentage: '7%',
      color: 'bg-cyan-500',
    },
  ];

  const transactions = [
    {
      id: '1',
      type: 'Disbursement',
      desc: 'Proposal #14 Funding',
      amount: '-15,000 XLM',
      date: 'June 02, 2026',
      status: 'Completed',
      statusColor: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    },
    {
      id: '2',
      type: 'Deposit',
      desc: 'DAO Staking Rewards',
      amount: '+4,200 XLM',
      date: 'May 31, 2026',
      status: 'Completed',
      statusColor: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    },
    {
      id: '3',
      type: 'Disbursement',
      desc: 'Developer Grant - Phase 1',
      amount: '-10,000 USDC',
      date: 'May 28, 2026',
      status: 'Completed',
      statusColor: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    },
  ];

  const fetchProposals = useCallback(async () => {
    if (!token) {
      setLoadingProposals(false);
      return;
    }
    try {
      const res = await apiFetch("/treasury/proposals", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as Proposal[];
        setProposals(data);
      }
    } catch {
      // network error — leave existing list in place
    } finally {
      setLoadingProposals(false);
    }
  }, [token]);

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  // Real-time proposal updates via Socket.IO
  useEffect(() => {
    if (!socket) return;

    function onProposalUpdated(data: {
      proposalId: string;
      status: Proposal["status"];
      approvalsCount: number;
      rejectionsCount: number;
    }) {
      setProposals((prev) =>
        prev.map((p) =>
          p.proposalId === data.proposalId
            ? { ...p, status: data.status, approvalsCount: data.approvalsCount, rejectionsCount: data.rejectionsCount }
            : p,
        ),
      );
    }

    socket.on("treasury_proposal_updated", onProposalUpdated);
    return () => {
      socket.off("treasury_proposal_updated", onProposalUpdated);
    };
  }, [socket]);

  const activeProposals = proposals.filter((p) => p.status === "active");

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight bg-gradient-to-r from-white via-foreground to-accent-light bg-clip-text text-transparent">
            Treasury Vault
          </h1>
          <p className="text-sm text-foreground/40 mt-1">
            Manage and track your DAO&apos;s multi-signature assets on Stellar.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsModalOpen(true)}
          className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent/90"
        >
          Propose Withdrawal
        </button>
      </div>

      <ProposeWithdrawalModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSuccess={fetchProposals}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="p-6 rounded-3xl bg-card/30 border border-border backdrop-blur-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-accent/5 rounded-full blur-2xl group-hover:bg-accent/10 transition-all duration-300" />
          <p className="text-xs font-semibold text-foreground/40 uppercase tracking-wider">
            Total Vault Value
          </p>
          <p className="text-3xl font-bold mt-2 font-sans tracking-tight">$64,750.00</p>
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full mt-3 border border-emerald-500/10">
            +4.2% (24h)
          </span>
        </div>

        <div className="p-6 rounded-3xl bg-card/30 border border-border backdrop-blur-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-all duration-300" />
          <p className="text-xs font-semibold text-foreground/40 uppercase tracking-wider">
            Active Multi-sig Signers
          </p>
          <p className="text-3xl font-bold mt-2 font-sans tracking-tight">3 of 5</p>
          <p className="text-xs text-foreground/30 mt-4">Threshold: 3 signatures required</p>
        </div>

        <div className="p-6 rounded-3xl bg-card/30 border border-border backdrop-blur-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl group-hover:bg-cyan-500/10 transition-all duration-300" />
          <p className="text-xs font-semibold text-foreground/40 uppercase tracking-wider">Pending Transactions</p>
          <p className="text-3xl font-bold mt-2 font-sans tracking-tight">{loadingProposals ? "—" : activeProposals.length}</p>
          <p className="text-xs text-foreground/30 mt-4">
            {activeProposals.length === 0 ? "All sign-offs completed" : `${activeProposals.length} awaiting signatures`}
          </p>
        </div>
      </div>

      {/* Active Proposals */}
      <div>
        <h2 className="text-lg font-bold text-foreground/90 mb-4">Active Proposals</h2>
        {loadingProposals ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-44 rounded-2xl bg-card/20 border border-border animate-pulse" />
            ))}
          </div>
        ) : proposals.length === 0 ? (
          <div className="p-8 rounded-2xl bg-card/20 border border-border text-center">
            <p className="text-foreground/40 text-sm">No proposals yet. Use &quot;Propose Withdrawal&quot; to create one.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {proposals.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                onVoted={() => fetchProposals()}
              />
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Assets List */}
        <div className="lg:col-span-2 p-6 rounded-3xl bg-card/30 border border-border backdrop-blur-md">
          <h3 className="font-bold text-lg mb-4 text-foreground/90">Asset Allocation</h3>
          <div className="space-y-5">
            {assets.map((asset) => (
              <div key={asset.symbol} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold">{asset.name}</p>
                    <p className="text-xs text-foreground/40">{asset.balance}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold">{asset.value}</p>
                    <p className="text-[10px] text-accent-light font-medium">{asset.percentage}</p>
                  </div>
                </div>
                <div className="h-1.5 w-full bg-white/[0.03] rounded-full overflow-hidden">
                  <div
                    className={`h-full ${asset.color} rounded-full`}
                    style={{ width: asset.percentage }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent Transactions */}
        <div className="lg:col-span-3 p-6 rounded-3xl bg-card/30 border border-border backdrop-blur-md">
          <h3 className="font-bold text-lg mb-4 text-foreground/90">Recent Activity</h3>
          <div className="space-y-4">
            {transactions.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between p-3.5 rounded-2xl bg-white/[0.01] border border-white/[0.03] hover:bg-white/[0.02] transition-all duration-300"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center text-xs font-semibold ${
                      tx.type === 'Deposit'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-accent/10 text-accent-light'
                    }`}
                  >
                    {tx.type[0]}
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{tx.desc}</p>
                    <p className="text-[10px] text-foreground/40">
                      {tx.date} • {tx.type}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p
                    className={`text-sm font-bold ${tx.type === 'Deposit' ? 'text-emerald-400' : 'text-foreground'}`}
                  >
                    {tx.amount}
                  </p>
                  <span
                    className={`inline-block text-[9px] font-semibold px-2 py-0.5 rounded-md border mt-1 ${tx.statusColor}`}
                  >
                    {tx.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
