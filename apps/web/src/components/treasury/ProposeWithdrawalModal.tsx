'use client';

import { useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import { apiFetch } from '@/lib/api';
import { useToast } from '@/lib/useToast';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

const TTL_OPTIONS = [
  { label: '24 hours', value: '24h' },
  { label: '72 hours', value: '72h' },
  { label: '7 days', value: '7d' },
] as const;

type TTL = (typeof TTL_OPTIONS)[number]['value'];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function ProposeWithdrawalModal({ isOpen, onClose, onSuccess }: Props) {
  const { success, error: toastError } = useToast();

  const [amount, setAmount] = useState('');
  const [token, setToken] = useState('XLM');
  const [recipient, setRecipient] = useState('');
  const [ttl, setTtl] = useState<TTL>('24h');
  const [recipientError, setRecipientError] = useState('');
  const [loading, setLoading] = useState(false);

  function validateRecipient(value: string): string {
    if (!value) return 'Recipient address is required';
    if (!STELLAR_ADDRESS_RE.test(value)) return 'Must be a valid Stellar address (G...)';
    return '';
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const recipientErr = validateRecipient(recipient);
    if (recipientErr) {
      setRecipientError(recipientErr);
      return;
    }

    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) return; // blocked by input[min]

    setLoading(true);
    try {
      const token_stored =
        typeof window !== 'undefined' ? window.localStorage.getItem('clicked.jwt') : null;
      const res = await apiFetch('/treasury/propose', {
        method: 'POST',
        body: JSON.stringify({ amount: parsedAmount, token, recipient, ttl }),
        headers: token_stored ? { Authorization: `Bearer ${token_stored}` } : {},
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toastError(body.error ?? 'Failed to submit proposal');
        return;
      }

      success('Withdrawal proposal submitted successfully');
      onSuccess();
      onClose();
      // Reset
      setAmount('');
      setToken('XLM');
      setRecipient('');
      setTtl('24h');
    } catch {
      toastError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Propose Withdrawal">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Amount */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1" htmlFor="pw-amount">
            Amount
          </label>
          <input
            id="pw-amount"
            type="number"
            min="0.0000001"
            step="any"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>

        {/* Token */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1" htmlFor="pw-token">
            Token
          </label>
          <select
            id="pw-token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="XLM">XLM</option>
            <option value="USDC">USDC</option>
            <option value="AQUA">AQUA</option>
          </select>
        </div>

        {/* Recipient */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1" htmlFor="pw-recipient">
            Recipient address
          </label>
          <input
            id="pw-recipient"
            type="text"
            required
            value={recipient}
            onChange={(e) => {
              setRecipient(e.target.value);
              if (recipientError) setRecipientError(validateRecipient(e.target.value));
            }}
            onBlur={() => setRecipientError(validateRecipient(recipient))}
            placeholder="G..."
            className={`w-full rounded-lg bg-white/5 border px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-accent ${
              recipientError ? 'border-rose-500' : 'border-white/10'
            }`}
          />
          {recipientError && <p className="mt-1 text-xs text-rose-400">{recipientError}</p>}
        </div>

        {/* TTL */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1" htmlFor="pw-ttl">
            Proposal duration
          </label>
          <select
            id="pw-ttl"
            value={ttl}
            onChange={(e) => setTtl(e.target.value as TTL)}
            className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {TTL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white transition hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Submitting…' : 'Submit Proposal'}
        </button>
      </form>
    </Modal>
  );
}
