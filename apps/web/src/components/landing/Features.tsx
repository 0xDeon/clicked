const FEATURES = [
  {
    icon: '💬',
    title: 'Wallet-to-Wallet Messaging',
    description:
      'Chat directly with any Stellar wallet address. No email, no username — just your public key.',
  },
  {
    icon: '💸',
    title: 'Send Tokens in Chat',
    description:
      'Transfer XLM or any Soroban token inside a conversation. Payments feel as natural as sending a message.',
  },
  {
    icon: '🏦',
    title: 'Group Treasuries',
    description:
      'Communities pool funds into a shared on-chain treasury. Transparent, permissionless, always auditable.',
  },
  {
    icon: '📋',
    title: 'Community Proposals',
    description:
      'Submit funding ideas and let the group decide. Proposals live on-chain — no back-room decisions.',
  },
  {
    icon: '🗳️',
    title: 'DAO-style Voting',
    description:
      'Lightweight on-chain voting tied to your wallet stake. One address, one voice — or weighted by contribution.',
  },
  {
    icon: '🤖',
    title: 'AI-powered Insights',
    description:
      'Fraud detection, proposal summarisation, and smart assistants baked into the conversation layer.',
  },
];

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-32">
      <div className="mb-16 text-center">
        <h2 className="text-3xl font-bold tracking-tight text-[var(--foreground)] sm:text-4xl">
          Everything in one place
        </h2>
        <p className="mt-4 text-[var(--foreground)]/50">
          No more switching between Telegram, Gnosis Safe, and Snapshot.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => (
          <div
            key={f.title}
            className="group rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 transition-colors hover:border-[var(--muted)]"
          >
            <span className="text-3xl">{f.icon}</span>
            <h3 className="mt-4 text-base font-semibold text-[var(--foreground)]">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--foreground)]/50">
              {f.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
