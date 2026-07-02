"use client";

import { useState } from "react";
import { signWalletMessage } from "@/lib/freighter";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/lib/useToast";
import { useAuth } from "@/contexts/AuthContext";

type ProposalStatus = "active" | "approved" | "rejected" | "executed" | "expired";

export interface Proposal {
  id: string;
  proposalId: string;
  status: ProposalStatus;
  approvalsCount: number;
  rejectionsCount: number;
  recipient: string | null;
  amount: string | null;
  token: string | null;
  threshold: number;
  hasVoted: boolean;
  myVote: "approve" | "reject" | null;
}

interface Props {
  proposal: Proposal;
  onVoted?: (id: string, vote: "approve" | "reject") => void;
}

const STATUS_STYLES: Record<ProposalStatus, string> = {
  active:   "text-blue-400 bg-blue-500/10 border-blue-500/20",
  approved: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  rejected: "text-rose-400 bg-rose-500/10 border-rose-500/20",
  executed: "text-purple-400 bg-purple-500/10 border-purple-500/20",
  expired:  "text-slate-400 bg-slate-500/10 border-slate-500/20",
};

const STATUS_LABEL: Record<ProposalStatus, string> = {
  active:   "Pending",
  approved: "Approved",
  rejected: "Rejected",
  executed: "Executed",
  expired:  "Expired",
};

function truncateAddress(address: string | null): string {
  if (!address) return "—";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ProposalCard({ proposal, onVoted }: Props) {
  const { token } = useAuth();
  const { success, error: toastError } = useToast();
  const [voting, setVoting] = useState<"approve" | "reject" | null>(null);
  const [localVote, setLocalVote] = useState<"approve" | "reject" | null>(proposal.myVote);

  const isDisabled = proposal.hasVoted || localVote !== null || proposal.status !== "active";
  const progressPct = Math.min(100, (proposal.approvalsCount / proposal.threshold) * 100);

  async function castVote(type: "approve" | "reject") {
    if (isDisabled || voting) return;
    setVoting(type);
    try {
      let signature: string | undefined;
      try {
        signature = await signWalletMessage(`${type}:${proposal.proposalId}`);
      } catch {
        toastError("Freighter signing was cancelled or failed");
        return;
      }

      const res = await apiFetch(`/treasury/proposals/${proposal.id}/${type}`, {
        method: "POST",
        body: JSON.stringify({ signature }),
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toastError(body.error ?? `Failed to ${type} proposal`);
        return;
      }

      setLocalVote(type);
      success(type === "approve" ? "Vote cast — approved" : "Vote cast — rejected");
      onVoted?.(proposal.id, type);
    } finally {
      setVoting(null);
    }
  }

  const hasVotedNow = isDisabled;

  return (
    <div className="p-5 rounded-2xl bg-card/30 border border-border backdrop-blur-md space-y-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold text-foreground/40 uppercase tracking-wider">
            Proposal #{proposal.proposalId}
          </p>
          <p className="text-base font-bold mt-0.5 truncate">
            {proposal.amount ?? "—"} {proposal.token ?? ""}
          </p>
          <p className="text-xs text-foreground/40 font-mono mt-0.5">
            → {truncateAddress(proposal.recipient)}
          </p>
        </div>
        <span
          className={`shrink-0 inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLES[proposal.status]}`}
        >
          {STATUS_LABEL[proposal.status]}
        </span>
      </div>

      {/* Approval progress */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-foreground/50">
          <span>Approvals</span>
          <span className="font-semibold tabular-nums">
            {proposal.approvalsCount} / {proposal.threshold}
          </span>
        </div>
        <div className="h-1.5 w-full bg-white/[0.04] rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Vote buttons */}
      <div className="flex gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => castVote("approve")}
          disabled={hasVotedNow || voting !== null}
          className={`flex-1 rounded-xl py-2 text-sm font-semibold transition ${
            localVote === "approve"
              ? "bg-emerald-500/20 text-emerald-300 cursor-default"
              : hasVotedNow || voting !== null
              ? "bg-white/5 text-foreground/25 cursor-not-allowed"
              : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25"
          }`}
        >
          {voting === "approve" ? "Signing…" : localVote === "approve" ? "Approved ✓" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => castVote("reject")}
          disabled={hasVotedNow || voting !== null}
          className={`flex-1 rounded-xl py-2 text-sm font-semibold transition ${
            localVote === "reject"
              ? "bg-rose-500/20 text-rose-300 cursor-default"
              : hasVotedNow || voting !== null
              ? "bg-white/5 text-foreground/25 cursor-not-allowed"
              : "bg-rose-500/15 text-rose-400 hover:bg-rose-500/25"
          }`}
        >
          {voting === "reject" ? "Signing…" : localVote === "reject" ? "Rejected ✗" : "Reject"}
        </button>
      </div>
    </div>
  );
}
