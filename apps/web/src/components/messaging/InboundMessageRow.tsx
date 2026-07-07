import type { InboundMessage } from '@/lib/crypto/types';
import { UnavailableMessagePlaceholder } from './UnavailableMessagePlaceholder';

interface InboundMessageRowProps {
  message: InboundMessage;
  isSelf: boolean;
  senderName?: string;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function InboundMessageRow({ message, isSelf, senderName }: InboundMessageRowProps) {
  return (
    <div className={`flex flex-col max-w-[70%] ${isSelf ? 'items-end' : 'items-start'}`}>
      {!isSelf && senderName && (
        <span className="text-xs text-[var(--muted)] mb-1 px-1">{senderName}</span>
      )}

      {message.status === 'decrypted' && message.plaintext ? (
        <div
          className={`px-3 py-2 rounded-2xl text-sm leading-relaxed break-words ${
            isSelf
              ? 'bg-[var(--accent)] text-white rounded-br-sm'
              : 'bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] rounded-bl-sm'
          }`}
        >
          {message.plaintext}
        </div>
      ) : message.status === 'unavailable' && message.unavailableReason ? (
        <UnavailableMessagePlaceholder reason={message.unavailableReason} />
      ) : (
        <div className="px-3 py-2 rounded-2xl text-xs text-[var(--muted)] italic">Decrypting…</div>
      )}

      <span className="text-[10px] text-[var(--muted)] mt-1 px-1">
        {formatTime(message.createdAt)}
      </span>
    </div>
  );
}
