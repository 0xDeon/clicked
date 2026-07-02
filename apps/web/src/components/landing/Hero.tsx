export function Hero() {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 pt-24 text-center">
      {/* Background glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div className="h-[600px] w-[600px] rounded-full bg-[var(--accent)]/10 blur-[120px]" />
      </div>

      <div className="relative z-10 flex max-w-3xl flex-col items-center gap-6">
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-4 py-1.5 text-xs font-medium text-[var(--accent-light)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-light)]" />
          Built on Stellar · Powered by Soroban
        </span>

        <h1 className="text-5xl font-bold leading-tight tracking-tight text-[var(--foreground)] sm:text-6xl lg:text-7xl">
          Chat. Pay.{' '}
          <span className="bg-gradient-to-r from-[var(--accent)] to-[var(--accent-light)] bg-clip-text text-transparent">
            Build together.
          </span>
        </h1>

        <p className="max-w-xl text-lg leading-relaxed text-[var(--foreground)]/60">
          Clicked is a decentralized messaging platform where you can send tokens as easily as
          messages, fund community ideas, and govern shared treasuries — all in one place.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row">
          <a
            href="/app"
            className="rounded-full bg-[var(--accent)] px-8 py-3 text-sm font-semibold text-white shadow-lg shadow-[var(--accent)]/20 transition-opacity hover:opacity-90"
          >
            Launch App
          </a>
          <a
            href="https://github.com/codebestia/clicked"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-[var(--border)] px-8 py-3 text-sm font-semibold text-[var(--foreground)]/70 transition-colors hover:border-[var(--muted)] hover:text-[var(--foreground)]"
          >
            View on GitHub
          </a>
        </div>
      </div>

      {/* Mock chat preview */}
      <div className="relative z-10 mt-20 w-full max-w-2xl">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-2xl shadow-black/40">
          <div className="mb-4 flex items-center gap-3 border-b border-[var(--border)] pb-4">
            <div className="h-8 w-8 rounded-full bg-[var(--accent)]/30" />
            <div>
              <p className="text-sm font-medium text-[var(--foreground)]">builders-dao</p>
              <p className="text-xs text-[var(--foreground)]/40">4 members</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 text-sm">
            <ChatBubble
              align="left"
              name="alice.xlm"
              message="Should we fund the new UI sprint? 🎨"
            />
            <ChatBubble
              align="right"
              name="You"
              message="Sent 50 XLM to the treasury ✓"
              highlight
            />
            <ChatBubble align="left" name="bob.xlm" message="Proposal live — 3/4 votes so far 🗳️" />
          </div>
        </div>
      </div>
    </section>
  );
}

function ChatBubble({
  align,
  name,
  message,
  highlight,
}: {
  align: 'left' | 'right';
  name: string;
  message: string;
  highlight?: boolean;
}) {
  return (
    <div className={`flex gap-2 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
      <div className="mt-1 h-6 w-6 shrink-0 rounded-full bg-[var(--muted)]" />
      <div
        className={`max-w-xs ${align === 'right' ? 'items-end' : 'items-start'} flex flex-col gap-0.5`}
      >
        <span className="px-1 text-xs text-[var(--foreground)]/40">{name}</span>
        <div
          className={`rounded-2xl px-4 py-2 text-sm ${
            highlight
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--border)] text-[var(--foreground)]/80'
          }`}
        >
          {message}
        </div>
      </div>
    </div>
  );
}
